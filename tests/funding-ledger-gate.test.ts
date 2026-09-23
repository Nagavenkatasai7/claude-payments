/**
 * Program-Fix 7 — the FUNDING GATE lives in the ledger claims (like the
 * compliance gate), so no caller can pay out a transfer whose async debit is
 * pending, failed or returned, and the guarded funding transitions are the
 * primary idempotency. Every row with funding_state NULL (every mock /
 * partner-settled row — i.e. all of production with the flag OFF) behaves
 * exactly as before.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { freshDb } from './helpers-db';
import type { Transfer, FundingState } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
let repo: ReturnType<typeof createTransferRepo>;

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

async function setFunding(id: string, state: FundingState | null, intent: string | null = 'pi_x') {
  await db.execute(sql`UPDATE transfers SET funding_provider = ${intent ? 'stripe' : null}, funding_intent_ref = ${intent}, funding_state = ${state} WHERE id = ${id}`);
}

beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db);
});

describe('ledger claims carry the funding gate', () => {
  it('markPaidIfAwaiting: NULL (legacy) and succeeded flip; pending/failed/returned never do', async () => {
    for (const [i, state] of ([null, 'succeeded', 'pending', 'failed', 'returned'] as const).entries()) {
      const id = `g${i}`;
      await repo.saveTransfer(makeTransfer({ id }));
      if (state) await setFunding(id, state);
      const paid = await repo.markPaidIfAwaiting(id);
      expect(!!paid, String(state)).toBe(state === null || state === 'succeeded');
    }
  });

  it('markInReviewIfAwaiting: a flagged row with a pending debit is NOT held (no "payment received" before funds)', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'h1', complianceStatus: 'flagged' }));
    await setFunding('h1', 'pending');
    expect(await repo.markInReviewIfAwaiting('h1')).toBeNull();
    await setFunding('h1', 'succeeded');
    expect((await repo.markInReviewIfAwaiting('h1'))?.status).toBe('in_review');
  });

  it('markPaidIfInReview: a held row whose debit was RETURNED can never be released to the rail', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'r1', status: 'in_review', complianceStatus: 'flagged' }));
    await setFunding('r1', 'returned');
    expect(await repo.markPaidIfInReview('r1')).toBeNull();
  });
});

describe('funding transitions (guarded, tenant-scoped)', () => {
  it('bindFundingIntent: write-once, awaiting + uncharged only, same intent re-binds idempotently, other intent refused', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'b1', partnerId: 'default' }));
    const bound = await repo.bindFundingIntent('b1', 'default', 'stripe', 'pi_1');
    expect(bound).toMatchObject({ fundingProvider: 'stripe', fundingIntentRef: 'pi_1', fundingState: 'pending' });
    expect(bound?.fundingRef).toBeUndefined(); // an intent is NOT a charge
    expect(await repo.bindFundingIntent('b1', 'default', 'stripe', 'pi_1')).toMatchObject({ fundingIntentRef: 'pi_1' });
    expect(await repo.bindFundingIntent('b1', 'default', 'stripe', 'pi_2')).toBeNull();
    expect(await repo.bindFundingIntent('b1', 'other', 'stripe', 'pi_1')).toBeNull(); // tenant scope
  });

  it('bindFundingIntent refuses a charged, paid or cancelled row', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'b2', fundingRef: 'mockfund-b2' }));
    await repo.saveTransfer(makeTransfer({ id: 'b3', status: 'paid' }));
    await repo.saveTransfer(makeTransfer({ id: 'b4', status: 'cancelled' }));
    for (const id of ['b2', 'b3', 'b4']) expect(await repo.bindFundingIntent(id, 'default', 'stripe', 'pi_9')).toBeNull();
  });

  it('bindFundingIntent re-arms a FAILED intent to pending (the sender retries on the same intent)', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'b5' }));
    await repo.bindFundingIntent('b5', 'default', 'stripe', 'pi_5');
    await setFunding('b5', 'failed', 'pi_5');
    expect(await repo.bindFundingIntent('b5', 'default', 'stripe', 'pi_5')).toMatchObject({ fundingState: 'pending' });
  });

  it('markFundingSucceeded: records the charge write-once, only for THIS tenant\'s bound intent, once', async () => {
    await repo.saveTransfer(makeTransfer({ id: 's1' }));
    await repo.bindFundingIntent('s1', 'default', 'stripe', 'pi_s1');
    expect(await repo.markFundingSucceeded('s1', 'other', 'pi_s1')).toBeNull();
    expect(await repo.markFundingSucceeded('s1', 'default', 'pi_other')).toBeNull();
    const ok = await repo.markFundingSucceeded('s1', 'default', 'pi_s1');
    expect(ok).toMatchObject({ fundingState: 'succeeded', fundingRef: 'pi_s1', status: 'awaiting_payment' });
    expect(await repo.markFundingSucceeded('s1', 'default', 'pi_s1')).toBeNull(); // replay is a no-op
  });

  it('markFundingFailed: pending → failed only', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'f1' }));
    await repo.bindFundingIntent('f1', 'default', 'stripe', 'pi_f1');
    expect(await repo.markFundingFailed('f1', 'default', 'pi_f1')).toMatchObject({ fundingState: 'failed' });
    expect(await repo.markFundingFailed('f1', 'default', 'pi_f1')).toBeNull();
    await setFunding('f1', 'succeeded', 'pi_f1');
    expect(await repo.markFundingFailed('f1', 'default', 'pi_f1')).toBeNull(); // never un-funds a success
  });

  it('markFundingReturned: succeeded/pending → returned by (partner, intent); other tenant untouched', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'ret1', status: 'paid' }));
    await setFunding('ret1', 'succeeded', 'pi_r');
    expect(await repo.markFundingReturned('other', 'pi_r')).toBeNull();
    expect(await repo.markFundingReturned('default', 'pi_r')).toMatchObject({ id: 'ret1', fundingState: 'returned', status: 'paid' });
    expect(await repo.markFundingReturned('default', 'pi_r')).toBeNull();
  });

  it('findByFundingIntent is tenant-scoped', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'fi1' }));
    await setFunding('fi1', 'pending', 'pi_fi');
    expect((await repo.findByFundingIntent('default', 'pi_fi'))?.id).toBe('fi1');
    expect(await repo.findByFundingIntent('other', 'pi_fi')).toBeNull();
  });

  it('setFundingRef (the generic HMAC route) never touches a row bound to a PSP intent', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'sf1' }));
    await setFunding('sf1', 'pending', 'pi_sf');
    await repo.setFundingRef('sf1', 'forged');
    expect((await repo.getTransfer('sf1'))?.fundingRef).toBeUndefined();
  });

  it('saveTransfer (whole-row upsert of a stale read) never rewrites the funding columns', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'u1' }));
    const stale = await repo.getTransfer('u1');
    await setFunding('u1', 'pending', 'pi_u1');
    await repo.saveTransfer({ ...stale!, adminNote: 'x' });
    expect(await repo.getTransfer('u1')).toMatchObject({ fundingIntentRef: 'pi_u1', fundingState: 'pending', fundingProvider: 'stripe' });
  });
});

describe('a bound intent counts as "possibly charged" on every void / edit path', () => {
  it('cancelIfCancellable refuses', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'c1' }));
    await setFunding('c1', 'pending');
    expect(await repo.cancelIfCancellable('c1', 'default')).toBeNull();
  });

  it('listStaleUnfunded skips it', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'st1', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }));
    await repo.saveTransfer(makeTransfer({ id: 'st2', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }));
    await setFunding('st1', 'pending');
    const ids = (await repo.listStaleUnfunded(new Date(Date.now() - 86_400_000))).map((t) => t.id);
    expect(ids).toEqual(['st2']);
  });

  it('isPayoutEditable / updateRecipientPhone refuse', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'pe1' }));
    await setFunding('pe1', 'pending');
    expect(await repo.isPayoutEditable('pe1', 'default')).toBe(false);
    expect(await repo.updateRecipientPhone('pe1', 'default', '15551234567', '919999999999')).toBeNull();
  });

  it('a pay-time re-screen BLOCK leaves a bound row awaiting_payment (never "blocked" while a debit may land)', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'rs1' }));
    await setFunding('rs1', 'pending');
    const r = await repo.applyRescreenIfAwaiting('rs1', 'default', 'blocked', ['x']);
    expect(r).toMatchObject({ status: 'awaiting_payment', complianceStatus: 'blocked' });
  });
});

describe('review M-1(a): the rail-callback flip carries the funding gate', () => {
  it.each([
    [null, true], ['succeeded', true], ['pending', false], ['failed', false], ['returned', false],
  ] as const)('awaiting_payment → paid via rail callback with funding_state %s ⇒ advances: %s', async (state, advances) => {
    const id = `rc_p_${state ?? 'null'}`;
    await repo.saveTransfer(makeTransfer({ id }));
    if (state) await setFunding(id, state);
    expect(!!(await repo.updateTransferFromWebhook(id, 'paid'))).toBe(advances);
  });

  it.each([
    [null, true], ['succeeded', true], ['pending', false], ['failed', false], ['returned', false],
  ] as const)('awaiting_payment → delivered via rail callback with funding_state %s ⇒ advances: %s', async (state, advances) => {
    const id = `rc_d_${state ?? 'null'}`;
    await repo.saveTransfer(makeTransfer({ id }));
    if (state) await setFunding(id, state);
    expect(!!(await repo.updateTransferFromWebhook(id, 'delivered'))).toBe(advances);
  });

  it('paid → delivered is NOT re-gated (the payout already went out; a return is alerted, not hidden)', async () => {
    await repo.saveTransfer(makeTransfer({ id: 'rc_pd', status: 'paid' }));
    await setFunding('rc_pd', 'returned');
    expect((await repo.updateTransferFromWebhook('rc_pd', 'delivered'))?.status).toBe('delivered');
  });
});

describe('review M-1(b): the stuck-paid sweep never re-instructs a RETURNED debit', () => {
  it('findStuckPaid skips funding_state returned; NULL and succeeded are still listed', async () => {
    const paidAt = new Date(Date.now() - 60 * 60_000).toISOString();
    for (const [id, state] of [['sp_null', null], ['sp_ok', 'succeeded'], ['sp_ret', 'returned']] as const) {
      await repo.saveTransfer(makeTransfer({ id, status: 'paid', paidAt }));
      if (state) await setFunding(id, state);
    }
    const ids = (await repo.findStuckPaid(15)).map((t) => t.id).sort();
    expect(ids).toEqual(['sp_null', 'sp_ok']);
  });
});
