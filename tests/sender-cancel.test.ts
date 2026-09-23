import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginSettlement, beginHold } from '@/lib/settlement';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { cancelPaidBySenderLocked, cancelWithinWindow } from '@/lib/sender-cancel';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';

// Program-Fix 15 PR C — the Reg E 30-minute sender cancel (12 CFR 1005.34),
// race-free. The locked claim takes the transfer FOR UPDATE, then a BLOCKING
// FOR UPDATE (never SKIP LOCKED) on every instruct:/reinstruct:/mocksettle:<id>
// outbox row. It auto-cancels only when every such row is pending, attempts 0
// and never claimed (locked_at IS NULL), marking them done in the same
// transaction; anything else escalates to staff. The 30-minute window is the
// stage1:<id> row's created_at against the DATABASE clock, so tests move it by
// back-dating that row (fake timers cannot move Postgres now()).
//
// PGlite runs one connection and serializes a statement issued while a
// transaction is open until that transaction commits. That models the
// blocking lock ("waits for the commit, then sees the committed row"), but it
// cannot exercise two truly concurrent Postgres sessions; the statement-order
// pin below proves the lock shape the production engine relies on.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
    webhookSecret: 'whk',
  },
  whatsapp: {},
};
const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };

const ID = 'sc_t1';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Test Recipient', recipientPhone: '919000000001',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
const fetchFn = vi.fn();
const refundFn = vi.fn(async () => ({ refundRef: 'rf-1' }));

function deps(): WorkerDeps {
  return {
    db, store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
    fundingProvider: {
      capture: vi.fn(),
      refund: refundFn,
      handleWebhook: vi.fn(),
    } as unknown as WorkerDeps['fundingProvider'],
  };
}

type Row = { id: number; kind: string; status: string; attempts: number; dedupe_key: string | null; last_error: string | null; payload: Record<string, unknown> };
async function outboxRows(): Promise<Row[]> {
  const r = await db.execute(sql`SELECT id, kind, status, attempts, dedupe_key, last_error, payload FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Row[] }).rows;
}
const byKey = async (k: string) => (await outboxRows()).find((r) => r.dedupe_key === k);

async function auditActions(): Promise<Array<{ action: string; actor: string; actor_type: string; meta: Record<string, unknown> }>> {
  const r = await db.execute(sql`SELECT action, actor, actor_type, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Array<{ action: string; actor: string; actor_type: string; meta: Record<string, unknown> }> }).rows;
}

/** Move the charge time (stage1:<id> created_at) `mins` minutes into the past. */
async function chargedMinutesAgo(mins: number, id = ID): Promise<void> {
  await db.execute(sql`UPDATE outbox SET created_at = now() - make_interval(mins => ${mins}) WHERE dedupe_key = ${`stage1:${id}`}`);
}

/** A charged (funding_ref set), cleared transfer settled onto the simulator rail. */
async function paidOnSimulator(over: Partial<Transfer> = {}): Promise<void> {
  await store.saveTransfer(fixture(over));
  await createTransferRepo(db).setFundingRef(ID, 'fund-1');
  const r = await beginSettlement(db, fixture(over), SIMULATOR);
  expect(r.kind).toBe('started');
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', SIMULATOR);
  fetchFn.mockReset();
  refundFn.mockClear();
});

describe('cancelWithinWindow — auto-cancel only while no rail instruction can have gone out', { retry: 0 }, () => {
  it('(a) instruct pending, attempts 0: cancelled, refund queued, instruct done, and a later drain makes NO rail POST', async () => {
    await paidOnSimulator();
    const r = await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' });
    expect(r).toEqual({ kind: 'cancelled', refundQueued: true });

    const t = await store.getTransfer(ID);
    expect(t?.status).toBe('cancelled');
    expect(t?.refundStatus).toBe('pending');

    const instruct = await byKey(`instruct:${ID}`);
    expect(instruct).toMatchObject({ status: 'done', attempts: 0, last_error: 'sender_cancel' });
    expect(await byKey(`refund:${ID}`)).toMatchObject({ kind: 'funding.refund', status: 'pending' });
    const confirm = await byKey(`sendercancel:${ID}`);
    expect(confirm).toMatchObject({ kind: 'whatsapp.text' });
    expect(confirm!.payload).toMatchObject({ to: '15551230000', partnerId: 'acme', category: 'essential' });
    expect(String(confirm!.payload.body)).toContain(ID);
    expect(String(confirm!.payload.body)).toMatch(/refund/i);

    const audit = await auditActions();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'transfer.sender_cancel', actor: 'system:customer-cancel', actor_type: 'system' });
    expect(audit[0].meta.via).toBe('receipt');
    expect(typeof audit[0].meta.msSinceCharge).toBe('number');
    // No PII in the audit meta.
    expect(JSON.stringify(audit[0].meta)).not.toMatch(/1555|9190|Test Recipient|HDFC/);

    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await drainOnce(deps(), 'w1');
    const railPosts = fetchFn.mock.calls.filter(([url]) => String(url).includes('rail.example'));
    expect(railPosts).toHaveLength(0);
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer(ID))?.refundStatus).toBe('completed');
  });

  it('(b) instruct row processing (claimed by a worker): escalate — no flip, refund requested, one ops alert', async () => {
    await paidOnSimulator();
    await createOutboxRepo(db).claimBatch(10, 'w1');
    expect((await byKey(`instruct:${ID}`))?.status).toBe('processing');

    const r = await cancelWithinWindow(db, 'acme', ID, { via: 'bot' });
    expect(r).toEqual({ kind: 'escalated' });
    const t = await store.getTransfer(ID);
    expect(t?.status).toBe('paid');
    expect(t?.refundStatus).toBe('requested');
    expect(await byKey(`refund:${ID}`)).toBeUndefined();
    expect(await byKey(`regecancel:${ID}`)).toMatchObject({ kind: 'ops.alert' });
    expect((await byKey(`instruct:${ID}`))?.status).toBe('processing');
    expect((await auditActions()).map((a) => a.action)).toEqual(['transfer.sender_cancel_escalated']);

    // Idempotent: a second request changes nothing and adds no second alert.
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'escalated' });
    expect((await outboxRows()).filter((x) => x.dedupe_key === `regecancel:${ID}`)).toHaveLength(1);
  });

  it('(c) instruct row pending with attempts >= 1 (a failed POST may have reached the rail): escalate', async () => {
    await paidOnSimulator();
    await db.execute(sql`UPDATE outbox SET attempts = 1 WHERE dedupe_key = ${`instruct:${ID}`}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it("(c') instruct row 'failed' (backing off): escalate", async () => {
    await paidOnSimulator();
    await db.execute(sql`UPDATE outbox SET status = 'failed', attempts = 1 WHERE dedupe_key = ${`instruct:${ID}`}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('(d) a reinstruct:<id> row that is not pending/0 escalates even when instruct: is pending/0', async () => {
    await paidOnSimulator();
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `reinstruct:${ID}` });
    await db.execute(sql`UPDATE outbox SET attempts = 1 WHERE dedupe_key = ${`reinstruct:${ID}`}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
    expect((await byKey(`instruct:${ID}`))?.status).toBe('pending');
  });

  it("(d') an instruct row already done (the rail was told) escalates", async () => {
    await paidOnSimulator();
    await db.execute(sql`UPDATE outbox SET status = 'done', attempts = 1 WHERE dedupe_key = ${`instruct:${ID}`}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('(e) mock rail: mocksettle pending/0 with the pre-set mock-<id> ref is cancelled, and mock.settle never runs', async () => {
    await store.saveTransfer(fixture());
    await createTransferRepo(db).setFundingRef(ID, 'fund-1');
    await beginSettlement(db, fixture(), MOCK);
    expect((await store.getTransfer(ID))?.paymentProviderRef).toBe(`mock-${ID}`);

    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'cancelled', refundQueued: true });
    expect(await byKey(`mocksettle:${ID}`)).toMatchObject({ status: 'done', last_error: 'sender_cancel' });
    // Even when the delayed row would be due, a drain never delivers it.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '1 minute' WHERE dedupe_key = ${`mocksettle:${ID}`}`);
    await drainOnce(deps(), 'w1');
    expect((await store.getTransfer(ID))?.status).toBe('cancelled');
  });

  it('(f) cancel vs a concurrent claimBatch: exactly one wins, in either order', async () => {
    // Cancel first: the claim issued while the cancel is open runs after its
    // commit and finds the instruct row done — nothing to POST.
    await paidOnSimulator();
    let claimP: Promise<Awaited<ReturnType<ReturnType<typeof createOutboxRepo>['claimBatch']>>> | null = null;
    const c1 = await db.transaction(async (tx) => {
      const claim = await cancelPaidBySenderLocked(tx, 'acme', ID);
      claimP = createOutboxRepo(db).claimBatch(10, 'w1'); // issued while the cancel holds its locks
      return claim;
    });
    const claimed1 = await claimP!;
    expect(c1.kind).toBe('cancelled');
    expect(claimed1.some((r) => r.dedupeKey === `instruct:${ID}`)).toBe(false);

    // Claim first: the cancel sees the row processing and escalates.
    db = await freshDb();
    store = createStore(fakeRedis(), db);
    await seedPartner(db, 'acme');
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', SIMULATOR);
    await paidOnSimulator();
    // The claim is IN FLIGHT (its UPDATE open) when the cancel starts: the
    // cancel waits for it to commit, then sees the row claimed.
    let cancelP: Promise<Awaited<ReturnType<typeof cancelWithinWindow>>> | null = null;
    const claimed2 = await db.transaction(async (tx) => {
      const rows = await createOutboxRepo(tx).claimBatch(10, 'w1');
      cancelP = cancelWithinWindow(db, 'acme', ID, { via: 'receipt' });
      return rows;
    });
    const c2 = await cancelP!;
    expect(claimed2.some((r) => r.dedupeKey === `instruct:${ID}`)).toBe(true);
    expect(c2.kind).toBe('escalated');
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it('(f) lock shape: transfer FOR UPDATE first, then a BLOCKING FOR UPDATE (no SKIP LOCKED) on the rail rows', async () => {
    await paidOnSimulator();
    const stop = captureQueries();
    await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' });
    const q = stop().map((x) => x.sql.toLowerCase());
    const transferLock = q.findIndex((s) => s.includes('from "transfers"') && s.includes('for update'));
    const railLock = q.findIndex((s) => s.includes('from "outbox"') && s.includes('dedupe_key') && s.includes('for update'));
    expect(transferLock).toBeGreaterThanOrEqual(0);
    expect(railLock).toBeGreaterThan(transferLock);
    expect(q[railLock]).not.toContain('skip locked');
    expect(q[railLock]).not.toContain('nowait');
  });

  it('(g) past 30 minutes after the charge: window_passed, nothing changes', async () => {
    await paidOnSimulator();
    await chargedMinutesAgo(31);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'window_passed' });
    const t = await store.getTransfer(ID);
    expect(t?.status).toBe('paid');
    expect(t?.refundStatus ?? 'none').toBe('none');
    expect((await byKey(`instruct:${ID}`))?.status).toBe('pending');
    expect(await auditActions()).toHaveLength(0);
  });

  it('(g) 29 minutes after the charge is still inside the window', async () => {
    await paidOnSimulator();
    await chargedMinutesAgo(29);
    expect((await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).kind).toBe('cancelled');
  });

  it('(h) a dead instruct row retried by staff (attempts reset, locked_at kept) escalates', async () => {
    await paidOnSimulator();
    const outbox = createOutboxRepo(db);
    const [row] = (await outbox.claimBatch(10, 'w1')).filter((r) => r.dedupeKey === `instruct:${ID}`);
    await db.execute(sql`UPDATE outbox SET status = 'dead', lease_owner = NULL, lease_until = NULL WHERE id = ${row.id}`);
    await outbox.retryDead(row.id);
    expect(await byKey(`instruct:${ID}`)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('a row claimed then released unstarted escalates (fail closed: a release never erases the claim evidence)', async () => {
    await paidOnSimulator();
    const outbox = createOutboxRepo(db);
    const [row] = (await outbox.claimBatch(10, 'w1')).filter((r) => r.dedupeKey === `instruct:${ID}`);
    await outbox.releaseUnstarted([row.id], 'w1');
    expect(await byKey(`instruct:${ID}`)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('(h) dead → staff Retry → claimed → released unstarted: still escalates (the rail may hold an earlier POST)', async () => {
    await paidOnSimulator();
    const outbox = createOutboxRepo(db);
    const [row] = (await outbox.claimBatch(10, 'w1')).filter((r) => r.dedupeKey === `instruct:${ID}`);
    await db.execute(sql`UPDATE outbox SET status = 'dead', attempts = 8, lease_owner = NULL, lease_until = NULL WHERE id = ${row.id}`);
    await outbox.retryDead(row.id);
    const [again] = (await outbox.claimBatch(10, 'w2')).filter((r) => r.dedupeKey === `instruct:${ID}`);
    await outbox.releaseUnstarted([again.id], 'w2');
    expect(await byKey(`instruct:${ID}`)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it('no rail row at all escalates (never cancel what we cannot prove un-instructed)', async () => {
    await paidOnSimulator();
    await db.execute(sql`DELETE FROM outbox WHERE dedupe_key = ${`instruct:${ID}`}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('a rail ack ref already on the row (not the mock ref) escalates', async () => {
    await paidOnSimulator();
    await createTransferRepo(db).setProviderRef(ID, 'rail-abc');
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
  });

  it('missing stage1:<id> row (the funded-callback path): FAIL CLOSED and escalate', async () => {
    await store.saveTransfer(fixture());
    await createTransferRepo(db).setFundingRef(ID, 'fund-1');
    await createTransferRepo(db).updateTransferFromWebhook(ID, 'paid');
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'escalated' });
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it('a released hold keeps its ORIGINAL charge time (paid_at reset does not reopen the window)', async () => {
    await store.saveTransfer(fixture({ complianceStatus: 'flagged' }));
    await beginHold(db, fixture({ complianceStatus: 'flagged' }));
    await chargedMinutesAgo(45);
    await createTransferRepo(db).markPaidIfInReview(ID);
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'window_passed' });
  });

  it('C4: in_review inside the window escalates — no flip, no auto-refund, refund requested for the reviewer', async () => {
    await store.saveTransfer(fixture({ complianceStatus: 'flagged' }));
    await createTransferRepo(db).setFundingRef(ID, 'fund-1');
    await beginHold(db, fixture({ complianceStatus: 'flagged' }));
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'escalated', held: true });
    const t = await store.getTransfer(ID);
    expect(t?.status).toBe('in_review');
    expect(t?.refundStatus).toBe('requested');
    expect(await byKey(`refund:${ID}`)).toBeUndefined();
    expect(await byKey(`regecancel:${ID}`)).toMatchObject({ kind: 'ops.alert' });
  });

  it('C4: in_review past the window is window_passed (nothing changes)', async () => {
    await store.saveTransfer(fixture({ complianceStatus: 'flagged' }));
    await beginHold(db, fixture({ complianceStatus: 'flagged' }));
    await chargedMinutesAgo(31);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'window_passed' });
    expect((await store.getTransfer(ID))?.refundStatus ?? 'none').toBe('none');
  });

  it('C4 legacy: an in_review row with NO stage1 and an old paid_at is window_passed (never escalated at any age)', async () => {
    await store.saveTransfer(fixture({ status: 'in_review', complianceStatus: 'flagged' }));
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '3 hours' WHERE id = ${ID}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'window_passed' });
    expect((await store.getTransfer(ID))?.refundStatus ?? 'none').toBe('none');
    expect(await byKey(`regecancel:${ID}`)).toBeUndefined();
    expect(await auditActions()).toHaveLength(0);
  });

  it('C4 legacy: an in_review row with NO stage1 and NO paid_at is window_passed', async () => {
    await store.saveTransfer(fixture({ status: 'in_review', complianceStatus: 'flagged' }));
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'window_passed' });
    expect(await byKey(`regecancel:${ID}`)).toBeUndefined();
  });

  it('C4 legacy: an in_review row with NO stage1 but paid_at inside the window escalates', async () => {
    await store.saveTransfer(fixture({ status: 'in_review', complianceStatus: 'flagged' }));
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '5 minutes' WHERE id = ${ID}`);
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'bot' })).toEqual({ kind: 'escalated', held: true });
    expect((await store.getTransfer(ID))?.status).toBe('in_review');
  });

  it('Program-Fix 44 parity: a SANDBOX transfer\'s cancel confirmation carries sandbox: true (the worker never sends it)', async () => {
    await paidOnSimulator({ environment: 'test' });
    expect((await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).kind).toBe('cancelled');
    expect((await byKey(`sendercancel:${ID}`))!.payload).toMatchObject({ sandbox: true });
  });

  it('a LIVE transfer\'s cancel confirmation carries no sandbox key (payload unchanged)', async () => {
    await paidOnSimulator();
    await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' });
    expect((await byKey(`sendercancel:${ID}`))!.payload).not.toHaveProperty('sandbox');
  });

  it('a partner-funded transfer (no captured charge) is cancelled with NO refund queued and no refund promise', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), SIMULATOR); // no funding_ref
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'cancelled', refundQueued: false });
    expect(await byKey(`refund:${ID}`)).toBeUndefined();
    // Ops are told to have the payment returned (nothing shows on Refunds).
    expect(await byKey(`sendercancelfunds:${ID}`)).toMatchObject({ kind: 'ops.alert' });
    const body = String((await byKey(`sendercancel:${ID}`))!.payload.body);
    expect(body).not.toMatch(/refund/i);
  });

  it('a refund already REQUESTED inside the window is cancelled and the refund queued', async () => {
    await paidOnSimulator();
    await createTransferRepo(db).updateRefund(ID, { refundStatus: 'requested' });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'cancelled', refundQueued: true });
    expect(await byKey(`sendercancelfunds:${ID}`)).toBeUndefined();
    expect((await store.getTransfer(ID))?.refundStatus).toBe('pending');
  });

  it('refund already pending (staff refund in flight): ineligible, nothing moves', async () => {
    await paidOnSimulator();
    await createTransferRepo(db).updateRefund(ID, { refundStatus: 'pending' });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'ineligible' });
    expect((await byKey(`instruct:${ID}`))?.status).toBe('pending');
  });

  it('B2B is not a consumer sender: ineligible', async () => {
    await paidOnSimulator({ transferType: 'b2b' });
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'ineligible' });
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it("tenant-scoped: another partner's id is not_found and nothing moves", async () => {
    await paidOnSimulator();
    expect(await cancelWithinWindow(db, 'default', ID, { via: 'receipt' })).toEqual({ kind: 'not_found' });
    expect((await store.getTransfer(ID))?.status).toBe('paid');
  });

  it('idempotent: a second cancel after success is ineligible with no duplicate effects', async () => {
    await paidOnSimulator();
    await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' });
    const before = (await outboxRows()).length;
    expect(await cancelWithinWindow(db, 'acme', ID, { via: 'receipt' })).toEqual({ kind: 'ineligible' });
    expect((await outboxRows()).length).toBe(before);
    expect(await auditActions()).toHaveLength(1);
  });
});
