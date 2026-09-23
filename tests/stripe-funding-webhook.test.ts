/**
 * Program-Fix 7 — processing a VERIFIED Stripe funding event against the
 * ledger (src/lib/stripe-funding-webhook.ts). Money rules under test:
 *  - a pending intent NEVER settles; only a verified, cross-checked
 *    `payment_intent.succeeded` records the charge, and settlement then goes
 *    through the one settleOrHold path (no second paid flip);
 *  - a signed success replayed twice settles exactly once (event-id dedupe +
 *    the guarded transition);
 *  - amount / currency / metadata / tenant mismatches never move money and
 *    raise ONE deduped ops alert;
 *  - test-mode (livemode:false) events never settle unless explicitly allowed;
 *  - an ACH return after success (charge.dispute.created) marks the debit
 *    returned, blocks any later payout (the ledger gate) and raises ONE ops
 *    alert — it never auto-refunds (a refund during a dispute can
 *    double-credit: https://docs.stripe.com/payments/ach-direct-debit);
 *  - everything is tenant-scoped to the partner whose endpoint secret
 *    verified the event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { freshDb, seedPartner } from './helpers-db';
import { processStripeFundingEvent } from '@/lib/stripe-funding-webhook';
import type { StripeFundingEvent } from '@/lib/providers/stripe-funding-provider';
import type { Transfer } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
let repo: ReturnType<typeof createTransferRepo>;

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 195, feeUsd: 4.99, totalChargeUsd: 199.99, fxRate: 85,
    amountInr: 16575, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'acme',
    amountSource: 195, feeSource: 4.99, totalChargeSource: 199.99, ...o,
  };
}

async function boundTransfer(id: string, o: Partial<Transfer> = {}, intent = `pi_${id}`) {
  await repo.saveTransfer(makeTransfer({ id, ...o }));
  await repo.bindFundingIntent(id, o.partnerId ?? 'acme', 'stripe', intent);
}

const succeeded = (id: string, o: Partial<Extract<StripeFundingEvent, { kind: 'succeeded' }>> = {}): StripeFundingEvent => ({
  kind: 'succeeded', eventId: `evt_${id}`, livemode: true, intentId: `pi_${id}`, amountReceived: 19999,
  currency: 'usd', transferId: id, partnerId: 'acme', ...o,
});

async function outboxRows(kind?: string) {
  const res = await db.execute(kind
    ? sql`SELECT kind, dedupe_key, payload FROM outbox WHERE kind = ${kind} ORDER BY id`
    : sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`);
  return (res as unknown as { rows: Array<{ kind: string; dedupe_key: string | null; payload: Record<string, unknown> }> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
});

describe('payment_intent.succeeded', () => {
  it('a pending intent with NO success event never settles', async () => {
    await boundTransfer('p0');
    const r = await processStripeFundingEvent(db, 'acme', { kind: 'processing', eventId: 'e0', livemode: true, intentId: 'pi_p0', transferId: 'p0', partnerId: 'acme' });
    expect(r.outcome).toBe('processing');
    expect((await repo.getTransfer('p0'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toEqual([]);
  });

  it('a verified, matching success records the charge and settles through settleOrHold — exactly once when replayed twice', async () => {
    await boundTransfer('s1');
    const first = await processStripeFundingEvent(db, 'acme', succeeded('s1'));
    const replay = await processStripeFundingEvent(db, 'acme', succeeded('s1'));
    const replay2 = await processStripeFundingEvent(db, 'acme', succeeded('s1', { eventId: 'evt_other_same_object' }));
    expect(first.outcome).toBe('funded');
    expect(replay.outcome).toBe('duplicate');
    expect(replay2.outcome).toBe('noop');
    const t = await repo.getTransfer('s1');
    expect(t).toMatchObject({ status: 'paid', fundingState: 'succeeded', fundingRef: 'pi_s1' });
    const stage1 = (await outboxRows('whatsapp.text')).filter((r) => r.dedupe_key === 'stage1:s1');
    const rail = (await outboxRows('mock.settle')).filter((r) => r.dedupe_key === 'mocksettle:s1');
    expect(stage1).toHaveLength(1);
    expect(rail).toHaveLength(1);
  });

  it.each([
    ['amount', { amountReceived: 19998 }],
    ['currency', { currency: 'eur' }],
    ['metadata transfer', { transferId: 'someone-else' }],
    ['metadata partner', { partnerId: 'globex' }],
  ])('a %s mismatch never moves money and raises ONE deduped alert', async (_label, over) => {
    await boundTransfer('m1');
    const r1 = await processStripeFundingEvent(db, 'acme', succeeded('m1', over));
    const r2 = await processStripeFundingEvent(db, 'acme', succeeded('m1', { ...over, eventId: 'evt_m1_again' }));
    expect(r1.outcome).toBe('mismatch');
    expect(r2.outcome).toBe('mismatch');
    const t = await repo.getTransfer('m1');
    expect(t).toMatchObject({ status: 'awaiting_payment', fundingState: 'pending' });
    expect(t?.fundingRef).toBeUndefined();
    const alerts = await outboxRows('ops.alert');
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].payload.message)).toContain('m1');
  });

  it('is tenant-scoped: another partner\'s verified event cannot fund this tenant\'s intent', async () => {
    await boundTransfer('t1');
    const r = await processStripeFundingEvent(db, 'globex', succeeded('t1', { partnerId: 'globex' }));
    expect(r.outcome).toBe('unknown_intent');
    expect((await repo.getTransfer('t1'))?.fundingState).toBe('pending');
  });

  it('test-mode (livemode:false) success never settles by default — alert only', async () => {
    await boundTransfer('lm1');
    const r = await processStripeFundingEvent(db, 'acme', succeeded('lm1', { livemode: false }));
    expect(r.outcome).toBe('test_mode_ignored');
    expect((await repo.getTransfer('lm1'))).toMatchObject({ status: 'awaiting_payment', fundingState: 'pending' });
    expect(await outboxRows('ops.alert')).toHaveLength(1);
  });

  it('test-mode success settles only when explicitly allowed', async () => {
    await boundTransfer('lm2');
    const r = await processStripeFundingEvent(db, 'acme', succeeded('lm2', { livemode: false }), { allowTestMode: true });
    expect(r.outcome).toBe('funded');
    expect((await repo.getTransfer('lm2'))?.status).toBe('paid');
  });

  it('a FLAGGED transfer is held (in_review) only after funds succeed', async () => {
    await boundTransfer('fl1', { complianceStatus: 'flagged' });
    await processStripeFundingEvent(db, 'acme', succeeded('fl1'));
    expect((await repo.getTransfer('fl1'))?.status).toBe('in_review');
  });

  it('success on a transfer that moved on (blocked by a re-screen) records the charge, never settles, alerts once', async () => {
    await boundTransfer('bl1');
    await repo.applyRescreenIfAwaiting('bl1', 'acme', 'blocked', ['sanctions']);
    const r = await processStripeFundingEvent(db, 'acme', succeeded('bl1'));
    expect(r.outcome).toBe('funded_not_settled');
    const t = await repo.getTransfer('bl1');
    expect(t).toMatchObject({ status: 'awaiting_payment', fundingRef: 'pi_bl1' });
    expect(await outboxRows('mock.settle')).toHaveLength(0);
    expect(await outboxRows('ops.alert')).toHaveLength(1);
  });
});

describe('payment_intent.payment_failed / canceled', () => {
  it('pending → failed; no money moves; the transfer stays payable', async () => {
    await boundTransfer('f1');
    const r = await processStripeFundingEvent(db, 'acme', { kind: 'failed', eventId: 'ef1', livemode: true, intentId: 'pi_f1', transferId: 'f1', partnerId: 'acme' });
    expect(r.outcome).toBe('failed');
    expect(await repo.getTransfer('f1')).toMatchObject({ status: 'awaiting_payment', fundingState: 'failed' });
    expect(await outboxRows()).toEqual([]);
  });
});

describe('charge.dispute.created (ACH return after success)', () => {
  const dispute = (id: string, o: Partial<Extract<StripeFundingEvent, { kind: 'dispute' }>> = {}): StripeFundingEvent => ({
    kind: 'dispute', eventId: `evd_${id}`, livemode: true, intentId: `pi_${id}`, chargeId: 'ch_1', disputeId: `du_${id}`,
    reason: 'insufficient_funds', status: 'needs_response', amount: 19999, currency: 'usd', ...o,
  });

  it('after payout: marks returned, ONE ops alert, NO refund effect', async () => {
    await boundTransfer('d1');
    await processStripeFundingEvent(db, 'acme', succeeded('d1'));
    const before = (await outboxRows('ops.alert')).length;
    const r = await processStripeFundingEvent(db, 'acme', dispute('d1'));
    await processStripeFundingEvent(db, 'acme', dispute('d1', { eventId: 'evd_again' }));
    expect(r.outcome).toBe('returned');
    expect((await repo.getTransfer('d1'))).toMatchObject({ status: 'paid', fundingState: 'returned' });
    const alerts = await outboxRows('ops.alert');
    expect(alerts.length - before).toBe(1);
    expect(String(alerts[alerts.length - 1].payload.message)).toMatch(/returned|dispute/i);
    expect(await outboxRows('funding.refund')).toHaveLength(0);
  });

  it('before payout (held in review): the release claim is now refused', async () => {
    await boundTransfer('d2', { complianceStatus: 'flagged' });
    await processStripeFundingEvent(db, 'acme', succeeded('d2'));
    await processStripeFundingEvent(db, 'acme', dispute('d2'));
    expect(await repo.markPaidIfInReview('d2')).toBeNull();
  });

  it('an authorization inquiry (warning_*) alerts but does not mark the debit returned', async () => {
    await boundTransfer('d3');
    await processStripeFundingEvent(db, 'acme', succeeded('d3'));
    const r = await processStripeFundingEvent(db, 'acme', dispute('d3', { status: 'warning_needs_response' }));
    expect(r.outcome).toBe('inquiry');
    expect((await repo.getTransfer('d3'))?.fundingState).toBe('succeeded');
  });

  it('a dispute with no payment_intent, or an unknown one, is alerted with the charge id — never dropped', async () => {
    const r1 = await processStripeFundingEvent(db, 'acme', dispute('x1', { intentId: null }));
    const r2 = await processStripeFundingEvent(db, 'acme', dispute('x2', { intentId: 'pi_unknown' }));
    expect(r1.outcome).toBe('unmatched_dispute');
    expect(r2.outcome).toBe('unmatched_dispute');
    const alerts = await outboxRows('ops.alert');
    expect(alerts).toHaveLength(2);
    expect(String(alerts[0].payload.message)).toContain('ch_1');
  });
});

describe('durability', () => {
  it('the event-id row and the funding transition commit together: a crash inside rolls both back (Stripe redelivers)', async () => {
    await boundTransfer('c1');
    const crashing = (d: Parameters<typeof createTransferRepo>[0]) => ({
      ...createTransferRepo(d),
      markFundingSucceeded: async () => { throw new Error('crash'); },
    });
    await expect(processStripeFundingEvent(db, 'acme', succeeded('c1'), { transferRepo: crashing })).rejects.toThrow('crash');
    const res = await db.execute(sql`SELECT count(*)::int AS n FROM funding_events`);
    expect((res as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
    expect((await repo.getTransfer('c1'))?.fundingState).toBe('pending');
    // Redelivery succeeds.
    expect((await processStripeFundingEvent(db, 'acme', succeeded('c1'))).outcome).toBe('funded');
  });
});
