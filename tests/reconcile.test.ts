import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { reconcileSweep, getOpsSnapshot, STALE_LOCK_MINUTES } from '@/lib/reconcile';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { beginHold, releaseHold } from '@/lib/settlement';
import { handleRailFailure } from '@/lib/rail-failure';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { cancelPaidBySenderLocked } from '@/lib/sender-cancel';
import { captureQueries } from './helpers-db';

// Program-Fix 15 PR C: a switch that makes findStuckPaid return a STALE
// snapshot (read before a concurrent sender cancel committed). Off (null) by
// default, so every other case runs the real repo unchanged.
const stuckSnapshot = vi.hoisted(() => ({ rows: null as Transfer[] | null }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...args: Parameters<typeof real.createTransferRepo>) => {
      const repo = real.createTransferRepo(...args);
      return {
        ...repo,
        findStuckPaid: async (m: number) => stuckSnapshot.rows ?? repo.findStuckPaid(m),
      };
    },
  };
});

// reconcileSweep — the Stage-2d safety net. Stuck/stale money states surface as
// EXACTLY-ONCE deduped outbox effects, no matter how often the sweep runs.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rc_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-01T00:00:00.000Z', paidAt: '2026-06-01T00:01:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  stuckSnapshot.rows = null;
});

describe('reconcileSweep — stuck paid (webhook-driven rail)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
  });

  it('re-instructs ONCE + alerts ONCE, and re-running the sweep adds NOTHING', async () => {
    await store.saveTransfer(fixture());

    const first = await reconcileSweep(db);
    expect(first).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    expect(await outboxRows()).toEqual([
      { kind: 'settlement.instruct', dedupe_key: 'reinstruct:rc_t1' },
      { kind: 'ops.alert', dedupe_key: 'recon:rc_t1' },
    ]);

    // The sweep runs on EVERY worker poke — dedupe keys make that safe.
    const second = await reconcileSweep(db);
    expect(second.stuckPaid).toBe(1);
    expect(second.reinstructed).toBe(0); // dedupe blocked the duplicate
    expect(await outboxRows()).toHaveLength(2);
  });

  it('a RELEASED hour-old compliance hold is NOT stuck: the first sweep after release re-instructs nothing and raises no recon alert', async () => {
    const t = fixture({ id: 'rc_rel', status: 'awaiting_payment', complianceStatus: 'flagged', paidAt: undefined });
    await store.saveTransfer(t);
    expect(await beginHold(db, t)).toEqual({ kind: 'held' });
    // The hold began an hour ago (beginHold set paid_at then).
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '1 hour' WHERE id = 'rc_rel'`);
    const integrations = await createIntegrationsRepo(db, provider).getIntegrations('acme');
    expect(await releaseHold(db, (await store.getTransfer('rc_rel'))!, integrations)).toEqual({ kind: 'released', webhookDriven: true });

    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect(r.stuckPaid).toBe(0);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:rc_rel', 'instruct:rc_rel']);
  });

  it('fix 29: a HELD row (railamount:<id>) across two sweeps → ONE recon alert that says it is held, ZERO reinstruct rows', async () => {
    await store.saveTransfer(fixture());
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'amount mismatch' }, { dedupeKey: 'railamount:rc_t1' });
    const first = await reconcileSweep(db);
    const second = await reconcileSweep(db);
    expect(first.reinstructed).toBe(0);
    expect(second.reinstructed).toBe(0);
    expect(second.stuckPaid).toBe(1); // stays visible until staff cancel/refund it
    const rows = await outboxRows();
    expect(rows.filter((r) => r.dedupe_key?.startsWith('reinstruct:'))).toEqual([]);
    expect(rows.filter((r) => r.dedupe_key === 'recon:rc_t1')).toHaveLength(1);
    const msg = ((await db.execute(sql`SELECT payload->>'message' AS m FROM outbox WHERE dedupe_key = 'recon:rc_t1'`)) as unknown as { rows: Array<{ m: string }> }).rows[0].m;
    expect(msg).toContain('rail reported a different amount');
    expect(msg).toContain('held, not re-instructed');
    expect(msg).not.toContain('Re-instructed');
  });

  it('a recently-paid transfer is NOT stuck (no effects)', async () => {
    await store.saveTransfer(fixture({ paidAt: new Date().toISOString() }));
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    expect(await outboxRows()).toHaveLength(0);
  });
});

// Program-Fix 8: a rail-failed transfer is invisible to EVERY sweep that
// could move or mis-alert on it.
describe('reconcileSweep — re-instruction vs a sender cancel (Program-Fix 15 PR C)', { retry: 0 }, () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
  });

  /** A paid row with a charge inside the window and a never-claimed instruct row. */
  async function paidWithUnrunInstruct(): Promise<Transfer> {
    const t = fixture({ paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('whatsapp.text', { to: t.phone, body: 'x', partnerId: 'acme' }, { dedupeKey: 'stage1:rc_t1' });
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '20 minutes' WHERE dedupe_key = 'stage1:rc_t1'`);
    await outbox.enqueue('settlement.instruct', { transferId: t.id }, { dedupeKey: 'instruct:rc_t1' });
    return (await store.getTransfer(t.id))!;
  }

  it('a STALE stuck-paid snapshot of a transfer the sender has since cancelled enqueues NO reinstruct row', async () => {
    const snapshot = await paidWithUnrunInstruct();
    await db.transaction(async (tx) => {
      expect((await cancelPaidBySenderLocked(tx, 'acme', 'rc_t1')).kind).toBe('cancelled');
    });
    stuckSnapshot.rows = [snapshot]; // findStuckPaid ran before the cancel committed
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect((await outboxRows()).map((x) => x.dedupe_key)).not.toContain('reinstruct:rc_t1');
    // The recon alert must not claim a re-instruction that never happened.
    const alert = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'recon:rc_t1'`);
    const msg = String((alert as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0]?.payload.message);
    expect(msg).not.toContain('Re-instructed');
    expect(msg).toContain('Not re-instructed');
  });

  it('a real re-instruction still says so in the recon alert', async () => {
    await store.saveTransfer(fixture());
    expect((await reconcileSweep(db)).reinstructed).toBe(1);
    const alert = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'recon:rc_t1'`);
    expect(String((alert as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0].payload.message)).toContain('Re-instructed the partner rail once.');
  });

  it('a sweep that starts while the cancel holds its locks re-instructs nothing (it runs after the commit)', async () => {
    const snapshot = await paidWithUnrunInstruct();
    stuckSnapshot.rows = [snapshot];
    let sweep: ReturnType<typeof reconcileSweep> | null = null;
    await db.transaction(async (tx) => {
      await cancelPaidBySenderLocked(tx, 'acme', 'rc_t1');
      sweep = reconcileSweep(db); // attempted between the cancel's lock and its commit
    });
    expect((await sweep!).reinstructed).toBe(0);
    expect((await outboxRows()).map((x) => x.dedupe_key)).not.toContain('reinstruct:rc_t1');
    expect((await store.getTransfer('rc_t1'))?.status).toBe('cancelled');
  });

  it('the reinstruct enqueue locks the transfer FOR UPDATE first (transfer → outbox lock order)', async () => {
    await store.saveTransfer(fixture());
    const stop = captureQueries();
    const r = await reconcileSweep(db);
    const q = stop().map((x) => x.sql.toLowerCase());
    expect(r.reinstructed).toBe(1);
    const lock = q.findIndex((s) => s.includes('from "transfers"') && s.includes('for update'));
    const insert = q.findIndex((s) => s.startsWith('insert into "outbox"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(lock);
  });

  it('a stuck row whose refund was requested since the snapshot is not re-instructed', async () => {
    await store.saveTransfer(fixture());
    const snapshot = (await store.getTransfer('rc_t1'))!;
    await createTransferRepo(db).updateRefund('rc_t1', { refundStatus: 'requested' });
    stuckSnapshot.rows = [snapshot];
    expect((await reconcileSweep(db)).reinstructed).toBe(0);
  });
});

describe('reconcileSweep — after a rail failure (fix 8)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
      whatsapp: {},
    });
  });

  it('a rail-failed CHARGED row (cancelled + refund pending) is not stuck-paid, not cancelcharged, and is never re-instructed', async () => {
    await store.saveTransfer(fixture({ fundingRef: 'mockfund-rc_t1' })); // paid 25 days ago: stuck by age
    await handleRailFailure(db, 'rc_t1', { code: 'failed', reason: 'account_unreachable' });
    const r = await reconcileSweep(db);
    expect(r.stuckPaid).toBe(0);
    expect(r.reinstructed).toBe(0);
    const keys = (await outboxRows()).map((x) => x.dedupe_key);
    expect(keys).toEqual(['refund:rc_t1', 'railfailmsg:rc_t1', 'railfail:rc_t1']);
    expect(keys.some((k) => k?.startsWith('reinstruct:') || k?.startsWith('recon:') || k?.startsWith('cancelcharged:'))).toBe(false);
  });

  it('a rail-failed row whose PRIOR refund had failed (cancelled + charged + refund failed) raises no cancelcharged alert — Refunds owns it', async () => {
    await store.saveTransfer(fixture({ fundingRef: 'mockfund-rc_t1' }));
    await createTransferRepo(db).updateRefund('rc_t1', { refundStatus: 'pending' });
    await createTransferRepo(db).updateRefund('rc_t1', { refundStatus: 'failed' });
    await handleRailFailure(db, 'rc_t1', { code: 'failed', reason: 'x' });
    await reconcileSweep(db);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['railfail:rc_t1']);
    expect((await getOpsSnapshot(db)).stuckPaid).toEqual([]);
    expect((await getOpsSnapshot(db)).refundsFailed.map((t) => t.id)).toEqual(['rc_t1']);
  });

  it('a rail-failed PARTNER-FUNDED row (cancelled, no fundingRef, refund none) raises no cancelcharged alert either (nothing was captured here)', async () => {
    await store.saveTransfer(fixture());
    await handleRailFailure(db, 'rc_t1', { code: 'failed', reason: 'x' });
    await reconcileSweep(db);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['railfailmsg:rc_t1', 'railfail:rc_t1']);
  });
});

describe('reconcileSweep — stuck paid (mock rail)', () => {
  it('alerts but NEVER re-instructs (there is no rail to instruct)', async () => {
    await store.saveTransfer(fixture()); // 'acme' has no integrations row ⇒ mock
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'recon:rc_t1' }]);
  });
});

describe('reconcileSweep — stuck paid (ROUTED via settlementPartnerId)', () => {
  it("classifies + re-instructs via the SETTLEMENT partner's rail (owner is mock)", async () => {
    // Owner 'acme' has NO integrations row ⇒ mock. The route is railp's rail —
    // without routing this transfer is misclassified and never re-instructed.
    await seedPartner(db, 'railp');
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(fixture({ settlementPartnerId: 'railp' }));

    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    expect(await outboxRows()).toEqual([
      { kind: 'settlement.instruct', dedupe_key: 'reinstruct:rc_t1' },
      { kind: 'ops.alert', dedupe_key: 'recon:rc_t1' },
    ]);
    // The alert points ops at the SETTLEMENT partner (whose rail owes the
    // callback), not just the brand owner.
    const alert = (await db.execute(
      sql`SELECT payload->>'message' AS message FROM outbox WHERE kind = 'ops.alert'`,
    )) as unknown as { rows: Array<{ message: string }> };
    expect(alert.rows[0].message).toContain('settles via railp');
    expect(alert.rows[0].message).toContain('Re-instructed the partner rail once.');
  });
});

describe('reconcileSweep — stale compliance reviews', () => {
  it('alerts exactly once for an in_review transfer older than 24h', async () => {
    await store.saveTransfer(fixture({ id: 'rc_rev1', status: 'in_review' }));
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 1, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'review:rc_rev1' }]);
    await reconcileSweep(db);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe('reconcileSweep — crash-resume (charged but never settled)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function victim(over: Partial<Transfer> = {}): Transfer {
    return fixture({
      id: 'rc_fund1',
      status: 'awaiting_payment',
      fundingRef: 'mockfund-rc_fund1',
      createdAt: minutesAgo(20),
      paidAt: undefined,
      ...over,
    });
  }

  it('resumes settlement EXACTLY ONCE (atomic claim) + alerts once, deduped across sweeps', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(victim());

    const first = await reconcileSweep(db);
    expect(first.fundingResumed).toBe(1);
    // beginSettlement committed the paid flip + stage-1 message + rail effect.
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('paid');
    const keys = (await outboxRows()).map((r) => r.dedupe_key);
    expect(keys).toContain('stage1:rc_fund1');
    expect(keys).toContain('instruct:rc_fund1');
    expect(keys).toContain('fundresume:rc_fund1');

    // Re-running the sweep can never settle (or message) twice: the transfer is
    // no longer awaiting_payment and the alert key is spent.
    const second = await reconcileSweep(db);
    expect(second.fundingResumed).toBe(0);
    expect(await outboxRows()).toHaveLength(keys.length);
  });

  it("routed victim: rail config resolves via the SETTLEMENT partner; the stage-1 row names the OWNER and holds no creds (fix 11)", async () => {
    await seedPartner(db, 'railp');
    const repo = createIntegrationsRepo(db, provider);
    // Owner 'acme' has NO rail of its own — only a BYO WhatsApp number.
    await repo.saveIntegrations('acme', {
      kyc: {}, payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    await repo.saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: { phoneNumberId: 'pn_railp', token: 'tok_railp' },
    });
    await store.saveTransfer(victim({ settlementPartnerId: 'railp' }));

    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(1);
    // Rail-side: railp is webhook-driven ⇒ a settlement.instruct row exists.
    expect((await outboxRows()).map((x) => x.dedupe_key)).toContain('instruct:rc_fund1');
    // Brand-side: the stage-1 message names the OWNER (its creds resolve at
    // drain time) — the row holds neither partner's token nor the rail's number.
    const stage1 = (await db.execute(sql`
      SELECT payload->>'partnerId' AS pid, (payload -> 'creds') IS NOT NULL AS has_creds, payload::text AS raw
      FROM outbox WHERE dedupe_key = 'stage1:rc_fund1'
    `)) as unknown as { rows: Array<{ pid: string | null; has_creds: boolean; raw: string }> };
    expect(stage1.rows[0].pid).toBe('acme');
    expect(stage1.rows[0].has_creds).toBe(false);
    expect(stage1.rows[0].raw).not.toMatch(/tok_acme|tok_railp|pn_railp/);
  });

  it('a FRESH charge still inside the grace window is left alone', async () => {
    await store.saveTransfer(victim({ createdAt: minutesAgo(2) }));
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(0);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('an old awaiting_payment row that was NEVER charged is not a victim', async () => {
    await store.saveTransfer(victim({ fundingRef: undefined }));
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a FLAGGED charged victim is HELD (in_review + stage1 row + its own deduped ops alert) and NO settlement.instruct is enqueued', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(victim({ complianceStatus: 'flagged' }));

    const first = await reconcileSweep(db);
    expect(first.fundingResumed).toBe(1); // resumed to its CORRECT next state (held)
    const after = await store.getTransfer('rc_fund1');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.fundingRef).toBe('mockfund-rc_fund1'); // the charge is not lost
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:rc_fund1' },
      { kind: 'ops.alert', dedupe_key: 'fundhold:rc_fund1' },
    ]);
    const alert = (await db.execute(
      sql`SELECT payload->>'message' AS message FROM outbox WHERE dedupe_key = 'fundhold:rc_fund1'`,
    )) as unknown as { rows: Array<{ message: string }> };
    expect(alert.rows[0].message).toContain('HELD for compliance review');

    // The stale-review sweep now owns it (>24h) — and re-sweeping adds nothing.
    const second = await reconcileSweep(db);
    expect(second.fundingResumed).toBe(0);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('a cleared charged victim still resumes to paid with the instruct row (regression)', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(victim());
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(1);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('paid');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual([
      'stage1:rc_fund1', 'instruct:rc_fund1', 'fundresume:rc_fund1',
    ]);
  });

  it('a CANCELLED row that was CHARGED and never refunded (the capture↔cancel race) raises ONE deduped cancelcharged:<id> alert and moves nothing', async () => {
    // captureFunding = provider.capture THEN setFundingRef; Task 5's cancel guard is
    // funding_ref IS NULL, so a cancel that lands between those two calls leaves
    // exactly this row. No sweep watched it before.
    await store.saveTransfer(victim({ status: 'cancelled', refundStatus: 'none' }));
    const first = await reconcileSweep(db);
    expect(first.fundingResumed).toBe(0);
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'cancelcharged:rc_fund1' }]);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('cancelled');
    await reconcileSweep(db);
    expect(await outboxRows()).toHaveLength(1);
    // A cancelled row whose refund is already in flight is NOT alerted by THIS arm (that is Task 5's
    // reject/refund path doing its job). Seed its funding.refund effect row first: without one, the
    // PRE-EXISTING stuck-refund sweep in the same reconcileSweep call selects rc_fund2 too
    // (listByRefundStatus('pending') → zero recent effect rows → `refundstuck:rc_fund2`, exactly as
    // 'a pending refund with NO effect row at all (lost effect) alerts immediately' pins), and the
    // whole-outbox assertion would read ['cancelcharged:rc_fund1', 'refundstuck:rc_fund2'].
    await store.saveTransfer(victim({ id: 'rc_fund2', status: 'cancelled', refundStatus: 'pending' }));
    await createOutboxRepo(db).enqueue('funding.refund', { transferId: 'rc_fund2' }, { dedupeKey: 'refund:rc_fund2' });
    await reconcileSweep(db);
    expect((await outboxRows()).map((x) => x.dedupe_key).filter((k) => k?.startsWith('cancelcharged:'))).toEqual(['cancelcharged:rc_fund1']);
    expect((await outboxRows()).map((x) => x.dedupe_key)).not.toContain('refundstuck:rc_fund2'); // fresh effect row ⇒ not stuck either
  });
});

describe('reconcileSweep — stuck refunds', () => {
  function pendingRefund(over: Partial<Transfer> = {}): Transfer {
    return fixture({
      id: 'rc_ref1',
      status: 'cancelled',
      fundingRef: 'mockfund-rc_ref1',
      refundStatus: 'pending',
      paidAt: undefined,
      ...over,
    });
  }

  it('alerts ONCE (deduped) when a refund has been in flight for over an hour', async () => {
    await store.saveTransfer(pendingRefund());
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('funding.refund', { transferId: 'rc_ref1' }, { dedupeKey: 'refund:rc_ref1' });
    await db.execute(sql`
      UPDATE outbox SET created_at = now() - interval '2 hours' WHERE kind = 'funding.refund'
    `);

    const first = await reconcileSweep(db);
    expect(first.stuckRefunds).toBe(1);
    const alerts = (await outboxRows()).filter((r) => r.dedupe_key === 'refundstuck:rc_ref1');
    expect(alerts).toEqual([{ kind: 'ops.alert', dedupe_key: 'refundstuck:rc_ref1' }]);

    // No auto-retry, and no alert spam: re-sweeping adds nothing.
    const second = await reconcileSweep(db);
    expect(second.stuckRefunds).toBe(1);
    expect((await outboxRows()).filter((r) => r.kind === 'ops.alert')).toHaveLength(1);
    expect((await outboxRows()).filter((r) => r.kind === 'funding.refund')).toHaveLength(1);
  });

  it('a refund that just went in flight is NOT stuck', async () => {
    await store.saveTransfer(pendingRefund());
    await createOutboxRepo(db).enqueue(
      'funding.refund', { transferId: 'rc_ref1' }, { dedupeKey: 'refund:rc_ref1' },
    );
    const r = await reconcileSweep(db);
    expect(r.stuckRefunds).toBe(0);
    expect((await outboxRows()).filter((x) => x.kind === 'ops.alert')).toHaveLength(0);
  });

  it('a pending refund with NO effect row at all (lost effect) alerts immediately', async () => {
    await store.saveTransfer(pendingRefund());
    const r = await reconcileSweep(db);
    expect(r.stuckRefunds).toBe(1);
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'refundstuck:rc_ref1' }]);
  });

  it('completed and failed refunds are not swept (failed has its own ops queue)', async () => {
    await store.saveTransfer(pendingRefund({ refundStatus: 'failed' }));
    await store.saveTransfer(pendingRefund({ id: 'rc_ref2', refundStatus: 'completed' }));
    const r = await reconcileSweep(db);
    expect(r.stuckRefunds).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('reconcileSweep — stale processing locks (the drain itself is down)', () => {
  async function claimAndStrand(ageMinutes: number): Promise<number> {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'x', turn: {} });
    const [row] = await outbox.claimBatch(1, 'w_dead');
    // Age the LEASE with SQL-relative time (CLAUDE.md fixture rule).
    await db.execute(sql`UPDATE outbox SET lease_until = now() - make_interval(mins => ${ageMinutes}) WHERE id = ${row.id}`);
    return row.id;
  }

  it('counts rows whose lease expired >15m and raises EXACTLY ONE deduped ops.alert per row', async () => {
    const id = await claimAndStrand(STALE_LOCK_MINUTES + 1);
    const first = await reconcileSweep(db);
    expect(first.staleLocks).toBe(1);
    expect(await outboxRows()).toEqual([
      { kind: 'agent.turn', dedupe_key: null },
      { kind: 'ops.alert', dedupe_key: `stalelock:${id}` },
    ]);
    const second = await reconcileSweep(db);
    expect(second.staleLocks).toBe(1);
    expect(await outboxRows()).toHaveLength(2); // deduped: nothing added
  });

  it('a live lease raises no alert, and a freshly-expired one is the DRAIN\'s job (reclaim), not the sweep\'s', async () => {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'live', turn: {} });
    await outbox.claimBatch(1, 'w_alive');
    await claimAndStrand(1); // expired 1 minute ago — claimBatch reclaims it on the next drain
    const r = await reconcileSweep(db);
    expect(r.staleLocks).toBe(0);
    expect((await outboxRows()).filter((o) => o.kind === 'ops.alert')).toHaveLength(0);
  });
});

describe('getOpsSnapshot', () => {
  it('returns the ops surfaces (pending, dead, stuck, stale, refund queues)', async () => {
    await store.saveTransfer(fixture());
    await store.saveTransfer(fixture({ id: 'rc_rev1', status: 'in_review' }));
    await store.saveTransfer(fixture({
      id: 'rc_req1', status: 'cancelled', fundingRef: 'f', refundStatus: 'requested',
    }));
    await store.saveTransfer(fixture({
      id: 'rc_fail1', status: 'cancelled', fundingRef: 'f', refundStatus: 'failed',
    }));
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('whatsapp.text', { to: 'x', body: 'y' });
    await db.execute(sql`INSERT INTO outbox (kind, payload, status) VALUES ('whatsapp.text', '{}'::jsonb, 'dead')`);
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, lease_until, lease_owner)
      VALUES ('agent.turn', '{}'::jsonb, 'processing', now() - interval '20 minutes', 'w_dead')`);

    const snap = await getOpsSnapshot(db);
    expect(snap.pendingOutbox).toBe(1);
    expect(snap.deadLetters).toHaveLength(1);
    expect(snap.stuckPaid.map((t) => t.id)).toEqual(['rc_t1']);
    expect(snap.staleReviews.map((t) => t.id)).toEqual(['rc_rev1']);
    expect(snap.refundsRequested.map((t) => t.id)).toEqual(['rc_req1']);
    expect(snap.refundsPending).toEqual([]);
    expect(snap.refundsFailed.map((t) => t.id)).toEqual(['rc_fail1']);
    expect(snap.pendingOutbox).toBe(1); // 'processing' is not "pending" — unchanged
    expect(snap.staleLocks.map((o) => o.kind)).toEqual(['agent.turn']);
  });
});

// Program-Fix 49C (tickets-01): the ticket first-response SLA is an OPS digest —
// ONE ops.alert per UTC day (`ticketsla:<yyyy-mm-dd>`) carrying the count and the
// oldest ids, never one alert per ticket (a months-old backlog would otherwise
// fire N alerts at deploy). The alert text carries ids and counts only — never a
// subject or a phone (customer-written text).
describe('reconcileSweep — ticket SLA digest (fix 49C)', () => {
  const HOUR = 3_600_000;
  async function overdueTicket(id: string, hoursAgo: number, priority = 'urgent'): Promise<void> {
    await db.execute(sql`
      INSERT INTO tickets (id, partner_id, kind, customer_phone, subject, status, priority, created_at, updated_at)
      VALUES (${id}, 'acme', 'customer', '15551230000', 'Private subject line', 'open', ${priority},
              now() - make_interval(hours => ${hoursAgo}), now())
    `);
    await db.execute(sql`
      INSERT INTO ticket_messages (ticket_id, actor_type, actor_id, body, internal, created_at)
      VALUES (${id}, 'customer', '15551230000', 'help', false, now() - make_interval(hours => ${hoursAgo}))
    `);
  }
  async function digestRows(): Promise<Array<{ dedupe_key: string; message: string }>> {
    const r = await db.execute(sql`
      SELECT dedupe_key, payload->>'message' AS message FROM outbox
      WHERE kind = 'ops.alert' AND starts_with(dedupe_key, 'ticketsla:') ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string; message: string }> }).rows;
  }

  it('N breaches → exactly 1 digest per day, deduped across sweeps; the SweepResult shape is unchanged', async () => {
    await overdueTicket('tk_b1', 24 * 90);
    await overdueTicket('tk_b2', 10);
    await overdueTicket('tk_b3', 30, 'normal');
    const today = new Date();
    const r = await reconcileSweep(db, today);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
    await reconcileSweep(db, today);
    await reconcileSweep(db, new Date(today.getTime() + 60_000));
    const rows = await digestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`ticketsla:${today.toISOString().slice(0, 10)}`);
    expect(rows[0].message).toContain('3 ');
    expect(rows[0].message).toContain('tk_b1');
    expect(rows[0].message).not.toContain('Private subject line');
    expect(rows[0].message).not.toContain('15551230000');
  });

  it('the next UTC day gets its own digest', async () => {
    await overdueTicket('tk_b1', 24 * 90);
    const day1 = new Date();
    await reconcileSweep(db, day1);
    await reconcileSweep(db, new Date(day1.getTime() + 24 * HOUR));
    expect((await digestRows()).map((x) => x.dedupe_key)).toEqual([
      `ticketsla:${day1.toISOString().slice(0, 10)}`,
      `ticketsla:${new Date(day1.getTime() + 24 * HOUR).toISOString().slice(0, 10)}`,
    ]);
  });

  it('no breaches → no digest row at all', async () => {
    await overdueTicket('tk_fresh', 1);
    await reconcileSweep(db);
    expect(await digestRows()).toHaveLength(0);
  });
});
