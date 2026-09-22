import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { handleRailFailure, alertRefusedDelivery } from '@/lib/rail-failure';
import { issueRefund, retryRefund } from '@/lib/dashboard-ops';
import { decideStaffCancel } from '@/lib/dashboard-cancel-policy';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Program-Fix 8 (money-02 / rail-02): a signed `failed` / `returned` callback on
// a PAID transfer commits, in ONE transaction: cancelled + refund pending (when
// refundable) + the funding.refund effect + the customer notice + one deduped
// ops alert. Other states only alert; cancelled is a no-op. Real Postgres
// (PGlite): the row lock, the guarded UPDATE and the dedupe keys are the test.

const FAILED = { code: 'failed' as const, reason: 'account_unreachable' };
const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rf_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: 'HDFC0001234 000000000000', fundingMethod: 'card',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: minsAgo(3), paidAt: minsAgo(2), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    fundingRef: 'mockfund-rf_t1',
    ...over,
  } as Transfer;
}

type Row = { kind: string; dedupe_key: string | null; payload: Record<string, unknown> };
let db: Db;
let store: ReturnType<typeof createStore>;
const rows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as { rows: Row[] }).rows;
const keys = async () => (await rows()).map((r) => r.dedupe_key);
const alertText = async (key: string) => String((await rows()).find((r) => r.dedupe_key === key)?.payload.message ?? '');
const load = (id = 'rf_t1') => createTransferRepo(db).getTransfer(id);

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
});

describe('handleRailFailure — a PAID, CHARGED consumer row (the normal case)', () => {
  it('ONE transaction: cancelled + refund pending, one refund:<id>, one railfailmsg:<id> ({to, body, partnerId} only), one railfail:<id>', async () => {
    await store.saveTransfer(fixture());
    const r = await handleRailFailure(db, 'rf_t1', FAILED);
    expect(r).toEqual({ kind: 'failed', refundStarted: true });

    const t = await load();
    expect(t).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(t?.adminNote).toContain('failed');
    expect(t?.adminNote).toContain('account_unreachable');

    const all = await rows();
    expect(all.map((x) => [x.kind, x.dedupe_key])).toEqual([
      ['funding.refund', 'refund:rf_t1'],
      ['whatsapp.text', 'railfailmsg:rf_t1'],
      ['ops.alert', 'railfail:rf_t1'],
    ]);
    expect(all[0].payload).toEqual({ transferId: 'rf_t1' });
    expect(Object.keys(all[1].payload).sort()).toEqual(['body', 'partnerId', 'to']);
    expect(all[1].payload.to).toBe('15551230000');
    expect(all[1].payload.partnerId).toBe('acme');
    expect(String(all[1].payload.body)).toMatch(/refund/i);
    expect(String(all[1].payload.body)).not.toContain('account_unreachable');
    const alert = String(all[2].payload.message);
    expect(alert).toContain('rf_t1');
    expect(alert).toContain('acme');
    expect(alert).toContain('failed');
    expect(alert).toContain('account_unreachable');
    expect(alert).toMatch(/none → pending/);
  });

  it('`returned` is handled the same way and the note records the code', async () => {
    await store.saveTransfer(fixture());
    const r = await handleRailFailure(db, 'rf_t1', { code: 'returned', reason: 'beneficiary closed' });
    expect(r.kind).toBe('failed');
    expect((await load())?.adminNote).toContain('returned');
  });

  it('the reason is UNTRUSTED: a 7+ digit run (an echoed account) is masked in the note and the alert', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rf_t1', { code: 'failed', reason: 'no such account 123456789012 at branch' });
    expect((await load())?.adminNote).not.toContain('123456789012');
    expect((await load())?.adminNote).toContain('…9012');
    expect(await alertText('railfail:rf_t1')).not.toContain('123456789012');
  });

  it('a routed transfer names the settlement partner in the alert', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer(fixture({ settlementPartnerId: 'railp' }));
    await handleRailFailure(db, 'rf_t1', FAILED);
    expect(await alertText('railfail:rf_t1')).toContain('railp');
  });

  it('ATOMIC: a throw after the claim persists NOTHING (row still paid, outbox empty)', async () => {
    await store.saveTransfer(fixture());
    // Wrap the handle so the transaction body completes (claim + every enqueue)
    // and THEN throws — the whole unit must roll back, or a crash between the
    // flip and the effects could strand a cancelled, unrefunded, unmessaged row.
    const exploding = {
      ...db,
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.transaction(async (tx) => { await fn(tx); throw new Error('boom after claim'); }),
    } as unknown as Db;
    await expect(handleRailFailure(exploding, 'rf_t1', FAILED)).rejects.toThrow('boom after claim');
    expect(await load()).toMatchObject({ status: 'paid', refundStatus: 'none' });
    expect(await rows()).toEqual([]);
  });

  it('REPLAY: the same failure again is a no-op — zero new rows, row unchanged', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rf_t1', FAILED);
    const before = await keys();
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'noop', refundStarted: false });
    expect(await keys()).toEqual(before);
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
  });

  it('a MISSING transfer is a no-op with no effects', async () => {
    expect(await handleRailFailure(db, 'ghost', FAILED)).toEqual({ kind: 'noop', refundStarted: false });
    expect(await rows()).toEqual([]);
  });
});

describe('handleRailFailure — funding legs', () => {
  it('PARTNER-PULLED B2B (bank_pull, no fundingRef): refund pending + a funding.refund row (the worker posts the REVERSE); reversal wording', async () => {
    await store.saveTransfer(fixture({ fundingRef: undefined, fundingMethod: 'bank_pull', transferType: 'b2b', achTokenRef: 'bankpull_x' }));
    const r = await handleRailFailure(db, 'rf_t1', FAILED);
    expect(r).toEqual({ kind: 'failed', refundStarted: true });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await keys()).toEqual(['refund:rf_t1', 'railfailmsg:rf_t1', 'railfail:rf_t1']);
    const body = String((await rows())[1].payload.body);
    expect(body).toMatch(/revers/i);
    expect(body).not.toContain('payment method');
  });

  it('PARTNER-FUNDED (partner-API confirm: no fundingRef, not pulled): cancelled, refund stays none, NO refund row, contact variant, alert says partner-funded', async () => {
    await store.saveTransfer(fixture({ fundingRef: undefined }));
    const r = await handleRailFailure(db, 'rf_t1', FAILED);
    expect(r).toEqual({ kind: 'failed', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
    expect(await keys()).toEqual(['railfailmsg:rf_t1', 'railfail:rf_t1']);
    const body = String((await rows())[0].payload.body);
    expect(body).toMatch(/contact you/i);
    expect(body.toLowerCase()).not.toContain('refund');
    expect(await alertText('railfail:rf_t1')).toMatch(/partner-funded/);
  });
});

describe('handleRailFailure — every prior refund status', () => {
  const prime = async (refund: 'requested' | 'pending' | 'completed' | 'failed') => {
    await store.saveTransfer(fixture());
    const repo = createTransferRepo(db);
    if (refund === 'requested') await repo.updateRefund('rf_t1', { refundStatus: 'requested' });
    else {
      await repo.updateRefund('rf_t1', { refundStatus: 'pending' });
      if (refund === 'completed') await repo.updateRefund('rf_t1', { refundStatus: 'completed', refundRef: 'r', refundedAt: NOW.toISOString() });
      if (refund === 'failed') await repo.updateRefund('rf_t1', { refundStatus: 'failed' });
    }
  };

  it('requested → pending with ONE refund row (the customer already asked; the rail confirms it)', async () => {
    await prime('requested');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'failed', refundStarted: true });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await keys()).toEqual(['refund:rf_t1', 'railfailmsg:rf_t1', 'railfail:rf_t1']);
  });

  it('pending (a staff refund in flight) → cancelled, NO second refund row, refund variant', async () => {
    await prime('pending');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'failed', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await keys()).toEqual(['railfailmsg:rf_t1', 'railfail:rf_t1']);
    expect(String((await rows())[0].payload.body)).toMatch(/refund/i);
  });

  it('completed → cancelled, no refund row, NO customer message (already refunded), alert only', async () => {
    await prime('completed');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'failed', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'completed' });
    expect(await keys()).toEqual(['railfail:rf_t1']);
  });

  it('failed → cancelled, refund stays failed, no refund row, NO message; the alert says retry from Refunds, and retryRefund then works', async () => {
    await prime('failed');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'failed', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'failed' });
    expect(await keys()).toEqual(['railfail:rf_t1']);
    expect(await alertText('railfail:rf_t1')).toMatch(/retry it from Refunds/);
    await retryRefund(db, 'rf_t1');
    expect((await load())?.refundStatus).toBe('pending');
    expect((await keys()).some((k) => k?.startsWith('refund:rf_t1:retry:'))).toBe(true);
  });
});

describe('handleRailFailure — rows that are not paid are never flipped', () => {
  it('DELIVERED (paid_out then failed): stays delivered, one "after delivery" alert, no refund, no customer message', async () => {
    await store.saveTransfer(fixture());
    expect((await createTransferRepo(db).updateTransferFromWebhook('rf_t1', 'delivered'))?.status).toBe('delivered');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'alert_only', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'delivered', refundStatus: 'none' });
    expect(await keys()).toEqual(['railfail:rf_t1:delivered']);
    expect(await alertText('railfail:rf_t1:delivered')).toMatch(/after delivery/i);
  });

  it.each(['awaiting_payment', 'in_review', 'blocked'] as const)('%s (never instructed): status unchanged, alert only', async (status) => {
    await store.saveTransfer(fixture({ status, paidAt: undefined, fundingRef: undefined, adminNote: 'keep' }));
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'alert_only', refundStarted: false });
    expect(await load()).toMatchObject({ status, refundStatus: 'none', adminNote: 'keep' });
    expect(await keys()).toEqual([`railfail:rf_t1:${status}`]);
    expect(await alertText(`railfail:rf_t1:${status}`)).toContain(status);
  });

  it('an early stray failure (awaiting_payment) never spends the key the REAL cancel alert uses later', async () => {
    await store.saveTransfer(fixture({ status: 'awaiting_payment', paidAt: undefined }));
    await handleRailFailure(db, 'rf_t1', FAILED);
    await store.saveTransfer(fixture()); // now paid + charged
    expect((await handleRailFailure(db, 'rf_t1', FAILED)).kind).toBe('failed');
    expect(await keys()).toEqual(['railfail:rf_t1:awaiting_payment', 'refund:rf_t1', 'railfailmsg:rf_t1', 'railfail:rf_t1']);
  });

  it('CANCELLED already: a no-op with no effects', async () => {
    await store.saveTransfer(fixture({ status: 'cancelled', adminNote: 'rejected in review' }));
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'noop', refundStarted: false });
    expect(await rows()).toEqual([]);
    expect((await load())?.adminNote).toBe('rejected in review');
  });
});

describe('alertRefusedDelivery — a paid_out that updateTransferFromWebhook refused', () => {
  it('failed THEN paid_out: the row stays cancelled, the delivery is refused, exactly ONE railconflict:<id> alert; a second paid_out adds nothing', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rf_t1', FAILED);
    const repo = createTransferRepo(db);
    expect(await repo.updateTransferFromWebhook('rf_t1', 'delivered')).toBeNull();
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(true);
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await keys()).toEqual(['refund:rf_t1', 'railfailmsg:rf_t1', 'railfail:rf_t1', 'railconflict:rf_t1']);
    expect(await alertText('railconflict:rf_t1')).toMatch(/moved twice/i);

    expect(await repo.updateTransferFromWebhook('rf_t1', 'delivered')).toBeNull();
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(false);
    expect(await keys()).toHaveLength(4);
  });

  it('a paid_out on a PAID row with a PENDING staff refund raises one railconflict alert', async () => {
    await store.saveTransfer(fixture());
    await issueRefund(db, 'rf_t1');
    expect(await createTransferRepo(db).updateTransferFromWebhook('rf_t1', 'delivered')).toBeNull();
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(true);
    expect(await keys()).toEqual(['refund:rf_t1', 'railconflict:rf_t1']);
  });

  it('a DUPLICATE paid_out on a delivered row (refunding or not) is silent, as before', async () => {
    await store.saveTransfer(fixture({ status: 'delivered', deliveredAt: minsAgo(1) }));
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(false);
    await issueRefund(db, 'rf_t1'); // a clawback in flight
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(false);
    expect(await keys()).toEqual(['refund:rf_t1']);
  });

  it('a refused paid_out on blocked / in_review, or a missing row, is silent', async () => {
    await store.saveTransfer(fixture({ status: 'in_review' }));
    expect(await alertRefusedDelivery(db, 'rf_t1')).toBe(false);
    expect(await alertRefusedDelivery(db, 'ghost')).toBe(false);
    expect(await rows()).toEqual([]);
  });
});

describe('staff refund and rail failure, both orders (invariant 5: never two refunds)', () => {
  it('issueRefund THEN the failure: cancelled + pending, still ONE funding.refund row', async () => {
    await store.saveTransfer(fixture());
    await issueRefund(db, 'rf_t1');
    expect(await handleRailFailure(db, 'rf_t1', FAILED)).toEqual({ kind: 'failed', refundStarted: false });
    expect(await load()).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect((await rows()).filter((r) => r.kind === 'funding.refund')).toHaveLength(1);
  });

  it('the failure THEN issueRefund: the staff path refuses (only paid or delivered), still ONE refund row', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rf_t1', FAILED);
    await expect(issueRefund(db, 'rf_t1')).rejects.toThrow(/only paid or delivered/);
    expect((await rows()).filter((r) => r.kind === 'funding.refund')).toHaveLength(1);
  });
});

describe('staff paths on a rail-failed row', () => {
  it('issueRefund refuses, decideStaffCancel is a noop, and the partner-scoped read shows cancelled', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rf_t1', FAILED);
    const t = (await load())!;
    await expect(issueRefund(db, 'rf_t1')).rejects.toThrow(/only paid or delivered/);
    expect(decideStaffCancel(t)).toEqual({ kind: 'noop' });
    // The partner API's GET /transactions/:id reads through getOwnedTransfer.
    expect((await createTransferRepo(db).getOwnedTransfer('acme', 'rf_t1'))?.status).toBe('cancelled');
  });
});
