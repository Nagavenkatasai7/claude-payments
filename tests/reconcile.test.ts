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
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import { SANCTIONS_FUNDS_RULE, SANCTIONS_NO_PAYOUT_SENTENCE } from '@/lib/sanctions/notices';

// Fix pack 2 T3: a switch that makes the resume re-screen throw (off by default).
const rescreenThrows = vi.hoisted(() => ({ value: false }));
// Pack 2 review F3 (C2): a hook run before each resume re-screen (advances a test clock).
const rescreenHook = vi.hoisted(() => ({ before: null as null | (() => void) }));
vi.mock('@/lib/pay-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-rescreen')>();
  return {
    ...real,
    rescreenOnFile: async (...a: Parameters<typeof real.rescreenOnFile>) => {
      if (rescreenThrows.value) throw new Error('screening unavailable');
      rescreenHook.before?.();
      return real.rescreenOnFile(...a);
    },
  };
});

// Pack 2 review R2 (E4): a hook run on every settlement.paused read (one per
// stuck-paid row): advances a test clock to model the stuck-paid bookkeeping.
const flagHook = vi.hoisted(() => ({ before: null as null | (() => void) }));
vi.mock('@/lib/flags', async (orig) => {
  const real = await orig<typeof import('@/lib/flags')>();
  return {
    ...real,
    isFlagOn: async (...a: Parameters<typeof real.isFlagOn>) => {
      flagHook.before?.();
      return real.isFlagOn(...a);
    },
  };
});
// Pack 2 review round 3 (K3): a hook run on every sanctions evidence read
// (advances a test clock to model a slow Neon read), and a count of the reads.
const evidenceHook = vi.hoisted(() => ({ before: null as null | (() => void), calls: [] as string[] }));
vi.mock('@/lib/sanctions/evidence-read', async (orig) => {
  const real = await orig<typeof import('@/lib/sanctions/evidence-read')>();
  return {
    ...real,
    listScreenEvidence: async (...a: Parameters<typeof real.listScreenEvidence>) => {
      evidenceHook.calls.push(a[1].id);
      evidenceHook.before?.();
      return real.listScreenEvidence(...a);
    },
  };
});
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (...a: Parameters<typeof real.logWarn>) => {
      logSpy.warn(...a);
      return real.logWarn(...a);
    },
  };
});

// Fix pack 2 T4: a switch that makes the list-hold sweep throw (off by default).
const listSweepThrows = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/list-hold-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/list-hold-rescreen')>();
  return {
    ...real,
    sweepListUnavailableHolds: async (...a: Parameters<typeof real.sweepListUnavailableHolds>) => {
      if (listSweepThrows.value) throw new Error('list sweep down');
      return real.sweepListUnavailableHolds(...a);
    },
  };
});

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
  rescreenThrows.value = false;
  rescreenHook.before = null;
  flagHook.before = null;
  evidenceHook.before = null;
  logSpy.warn.mockClear();
  listSweepThrows.value = false;
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
    expect(first).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
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

  it('M3-15b: while an instruct row for the transfer is still LIVE (pending/processing/failed), the sweep does NOT re-instruct; once it is dead, it re-instructs ONCE', async () => {
    await store.saveTransfer(fixture());
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('settlement.instruct', { transferId: 'rc_t1' }, { dedupeKey: 'instruct:rc_t1' });
    for (const status of ['pending', 'processing', 'failed']) {
      await db.execute(sql`UPDATE outbox SET status = ${status} WHERE dedupe_key = 'instruct:rc_t1'`);
      expect((await reconcileSweep(db)).reinstructed, status).toBe(0);
      expect((await outboxRows()).map((x) => x.dedupe_key), status).not.toContain('reinstruct:rc_t1');
    }
    const alert = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'recon:rc_t1'`);
    const msg = String((alert as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0].payload.message);
    expect(msg).toContain('still queued or retrying');
    expect(msg).not.toContain('Re-instructed');
    // The live row dies: the sweep's one recovery re-instruction is still available, exactly once.
    await db.execute(sql`UPDATE outbox SET status = 'dead' WHERE dedupe_key = 'instruct:rc_t1'`);
    expect((await reconcileSweep(db)).reinstructed).toBe(1);
    expect((await reconcileSweep(db)).reinstructed).toBe(0);
    expect((await outboxRows()).filter((x) => x.dedupe_key === 'reinstruct:rc_t1')).toHaveLength(1);
  });

  it('M3-15b: a DONE instruct row (the rail took it, the callback is late) does not block the one re-instruction', async () => {
    await store.saveTransfer(fixture());
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'rc_t1' }, { dedupeKey: 'instruct:rc_t1' });
    await db.execute(sql`UPDATE outbox SET status = 'done' WHERE dedupe_key = 'instruct:rc_t1'`);
    expect((await reconcileSweep(db)).reinstructed).toBe(1);
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

  // Inventory (S5): a held row that is also sanctions-BLOCKED (the heal matched
  // a possibly instructed row; the rail then paid out a different amount)
  // never gets "cancel/refund it"; any other held row keeps it.
  it('S5: a HELD (railamount) row that is sanctions-BLOCKED: the recon alert has the no-refund rule; an unblocked held row keeps "cancel/refund it."', async () => {
    await store.saveTransfer(fixture({ complianceStatus: 'blocked', complianceReasons: ['Recipient matches a sanctions watchlist.'] }));
    await store.saveTransfer(fixture({ id: 'rc_t2' }));
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'amount mismatch' }, { dedupeKey: 'railamount:rc_t1' });
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'amount mismatch' }, { dedupeKey: 'railamount:rc_t2' });
    await reconcileSweep(db);
    const recon = async (id: string) =>
      ((await db.execute(sql`SELECT payload->>'message' AS m FROM outbox WHERE dedupe_key = ${`recon:${id}`}`)) as unknown as { rows: Array<{ m: string }> }).rows[0].m;
    expect(await recon('rc_t1')).toBe(
      "⚠️ SmartRemit ops: transfer rc_t1 (partner acme) has been 'paid' for >15min with no delivery confirmation." +
        ' The rail reported a different amount — held, not re-instructed. It is blocked by sanctions screening: investigate with the rail, and ' +
        `${SANCTIONS_FUNDS_RULE}.`,
    );
    expect(await recon('rc_t2')).toBe(
      "⚠️ SmartRemit ops: transfer rc_t2 (partner acme) has been 'paid' for >15min with no delivery confirmation." +
        ' The rail reported a different amount — held, not re-instructed. Investigate with the rail, then cancel/refund it.',
    );
  });

  it('a recently-paid transfer is NOT stuck (no effects)', async () => {
    await store.saveTransfer(fixture({ paidAt: new Date().toISOString() }));
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
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
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
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
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
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
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 1, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'review:rc_rev1' }]);
    await reconcileSweep(db);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('ignores a SANDBOX (test-environment) in_review transfer older than 24h; a live one next to it still alerts', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    await store.saveTransfer(fixture({
      id: 'rc_sbrev', status: 'in_review', environment: 'test', createdAt: hoursAgo(49), paidAt: hoursAgo(48),
    }));
    await store.saveTransfer(fixture({
      id: 'rc_liverev', status: 'in_review', createdAt: hoursAgo(49), paidAt: hoursAgo(48),
    }));
    const r = await reconcileSweep(db);
    expect(r.staleReviews).toBe(1);
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'review:rc_liverev' }]);
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

  // Review S6 (Y3): the text of the cancelcharged:<id> alert, by compliance.
  const cancelChargedText = async (id: string) =>
    ((await db.execute(sql`SELECT payload->>'message' AS m FROM outbox WHERE dedupe_key = ${`cancelcharged:${id}`}`)) as unknown as {
      rows: Array<{ m: string }>;
    }).rows[0]?.m;

  it('S6: a cancelled, charged row that is NOT blocked keeps the "refund it by hand" text', async () => {
    await store.saveTransfer(victim({ status: 'cancelled', refundStatus: 'none' }));
    await reconcileSweep(db);
    expect(await cancelChargedText('rc_fund1')).toBe(
      '⚠️ SmartRemit ops: transfer rc_fund1 (partner acme) is CANCELLED but was CHARGED (mockfund-rc_fund1) and has no refund in flight — refund it by hand.',
    );
  });

  it('S6: a cancelled, charged row BLOCKED by sanctions screening: same cancelcharged:<id> key, the no-refund rule, never "refund it by hand"', async () => {
    await store.saveTransfer(victim({
      status: 'cancelled', refundStatus: 'none',
      complianceStatus: 'blocked', complianceReasons: ['Recipient matches a sanctions watchlist.'],
    }));
    await reconcileSweep(db);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['cancelcharged:rc_fund1']);
    const text = await cancelChargedText('rc_fund1');
    expect(text).toBe(
      `⚠️ SmartRemit ops: transfer rc_fund1 (partner acme) is CANCELLED, was CHARGED (mockfund-rc_fund1) and is blocked by sanctions screening; ${SANCTIONS_FUNDS_RULE}.`,
    );
    expect(text).not.toMatch(/refund it by hand/);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('cancelled');
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

  it('staleReviews lists live holds only: a sandbox in_review row older than 24h is not an ops item', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    await store.saveTransfer(fixture({ id: 'rc_sbrev', status: 'in_review', environment: 'test', paidAt: hoursAgo(30) }));
    await store.saveTransfer(fixture({ id: 'rc_liverev', status: 'in_review', paidAt: hoursAgo(30) }));
    expect((await getOpsSnapshot(db)).staleReviews.map((t) => t.id)).toEqual(['rc_liverev']);
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
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0, listHoldsReleased: 0 });
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

// Fix pack 2 T3 (R02): the non-Stripe crash-resume of a real-money (http rail)
// row re-screens when its newest evidence is not a live, fresh screen; a hold
// waiting on the list says so in the ops copy.
describe('reconcileSweep — real-money resume needs a live, fresh screen (fix pack 2 T3)', { retry: 0 }, () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const victim = (over: Partial<Transfer> = {}) =>
    fixture({ id: 'rc_lv1', status: 'awaiting_payment', fundingRef: 'mockfund-rc_lv1', createdAt: minutesAgo(20), paidAt: undefined, ...over });
  async function rail(providerType: 'http' | 'mock') {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: providerType === 'http'
        ? { providerType: 'http', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' }
        : { providerType: 'mock' },
      whatsapp: {},
    });
  }
  const message = async (key: string) =>
    ((await db.execute(sql`SELECT payload->>'message' AS message FROM outbox WHERE dedupe_key = ${key}`)) as unknown as {
      rows: Array<{ message: string }>;
    }).rows[0]?.message;
  const screens = async (id: string) =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id}`)) as unknown as {
      rows: Array<{ n: number }>;
    }).rows[0].n;

  it('a charged http row whose evidence is stale is re-screened and HELD (LIST_UNAVAILABLE), with the list copy in the fundhold alert', async () => {
    await rail('http');
    await store.saveTransfer(victim());
    await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(1);
    const after = await store.getTransfer('rc_lv1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toContain(LIST_UNAVAILABLE_REASON);
    const keys = (await outboxRows()).map((x) => x.dedupe_key);
    expect(keys).not.toContain('instruct:rc_lv1');
    expect(keys).toContain('fundhold:rc_lv1');
    const m = await message('fundhold:rc_lv1');
    expect(m).toContain('fresh sanctions list');
    expect(m).toContain('released automatically');
    expect(m).toContain('list loader');
    expect(await screens('rc_lv1')).toBe(2);
  });

  // Review round 3 (M2): the resumed row is charged by definition, so its
  // block notices say the sender was charged (ops alert and partner email).
  it('M2: a charged http row whose resume re-screen matches: the block alert and the partner email say the sender was charged', async () => {
    const originalList = process.env.SANCTIONS_LIST;
    try {
      primeOfacSource({ checkedAgoMs: 3_600_000 });
      await rail('http');
      await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
      await store.saveTransfer(victim({ recipientName: 'Testa Fixturelli' }));
      await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Testa Fixturelli' }, { screenedAgoMs: 40 * 3_600_000 });
      await reconcileSweep(db);
      expect((await store.getTransfer('rc_lv1'))?.complianceStatus).toBe('blocked');
      const block = await message('sanctionsblock:rc_lv1');
      expect(block).toContain('the sender was charged');
      expect(block).not.toContain('Nothing paid out');
      const mail = ((await db.execute(sql`SELECT payload->>'text' AS t FROM outbox WHERE dedupe_key = 'sanctionsblockmail:rc_lv1:acme'`)) as unknown as {
        rows: Array<{ t: string }>;
      }).rows[0]?.t;
      expect(mail).toContain('after the sender was charged');
      for (const m of [block, mail]) expect(m.toLowerCase()).not.toMatch(/testa|fixturelli/);
    } finally {
      restoreOfacSource(originalList);
    }
  });

  it('a mock rail resumes as before: no re-screen, paid', async () => {
    await rail('mock');
    await store.saveTransfer(victim());
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(1);
    expect((await store.getTransfer('rc_lv1'))?.status).toBe('paid');
    expect(await screens('rc_lv1')).toBe(0);
  });

  it('a re-screen that throws leaves the row untouched (the next sweep retries)', async () => {
    await rail('http');
    rescreenThrows.value = true;
    await store.saveTransfer(victim());
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(0);
    expect((await store.getTransfer('rc_lv1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toEqual([]);
  });

  // Pack 2 review F3 (C2): the resume re-screens run before the worker drain,
  // so they share a time budget: once it is spent no further re-screen starts
  // (that row is left untouched for the next sweep).
  it('time budget: a re-screen that spends the budget -> the next victim is not re-screened this sweep', async () => {
    await rail('http');
    for (const id of ['rc_lvb1', 'rc_lvb2']) {
      await store.saveTransfer(victim({ id, fundingRef: `mockfund-${id}` }));
      await seedLiveEvidence(db, { id, partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    }
    const clock = { t: 5_000_000 };
    rescreenHook.before = () => { clock.t += 10_000; };
    const r = await reconcileSweep(db, new Date(), { rescreenBudgetMs: 5_000, clock: () => clock.t });
    expect(r.fundingResumed).toBe(1);
    const statuses = [(await store.getTransfer('rc_lvb1'))?.status, (await store.getTransfer('rc_lvb2'))?.status].sort();
    expect(statuses).toEqual(['awaiting_payment', 'in_review']);
    expect((await screens('rc_lvb1')) + (await screens('rc_lvb2'))).toBe(3);
    // The next sweep (a fresh budget) takes the row left behind.
    rescreenHook.before = null;
    expect((await reconcileSweep(db, new Date(), { rescreenBudgetMs: 5_000, clock: () => clock.t })).fundingResumed).toBe(1);
  });

  // Pack 2 review R2 (E4): the budget is charged only for time spent INSIDE a
  // re-screen, so a long stuck-paid backlog (bookkeeping, no re-screen) never
  // starves the crash-resume re-screen.
  it('E4: 200 stuck-paid rows of bookkeeping (~50 ms each) do not spend the budget: the charged victim is still re-screened', async () => {
    await rail('http');
    await store.saveTransfer(victim());
    await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    // 200 long-stuck rows on another tenant's mock rail (alert only, no re-screen).
    stuckSnapshot.rows = Array.from({ length: 200 }, (_, i) => fixture({ id: `rc_bk${i}`, partnerId: 'bulk' }));
    const clock = { t: 5_000_000 };
    flagHook.before = () => { clock.t += 50; };
    const r = await reconcileSweep(db, new Date(), { rescreenBudgetMs: 5_000, clock: () => clock.t });
    expect(clock.t - 5_000_000).toBeGreaterThanOrEqual(200 * 50); // the bookkeeping took 10 s of the test clock
    expect(r.stuckPaid).toBe(200);
    expect(await screens('rc_lv1')).toBe(2);
    expect(r.fundingResumed).toBe(1);
    expect((await store.getTransfer('rc_lv1'))?.status).toBe('in_review');
    expect(logSpy.warn.mock.calls.filter((c) => c[0] === 'reconcile.rescreen-deferred')).toEqual([]);
  });

  // Pack 2 review round 3 (K3): a skipped heal costs nothing against the
  // budget. A paid+blocked real-money row is skipped before the heal with no
  // read; the heal's cheap "needs a heal?" reads of any other stuck row run
  // outside the budget. The re-instruct and the recon alert run for every row.
  it('K3: 120 paid+blocked http rows (50 ms per evidence read) do not spend the budget, and are not read at all', async () => {
    await rail('http');
    await store.saveTransfer(victim());
    await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    stuckSnapshot.rows = Array.from({ length: 120 }, (_, i) =>
      fixture({ id: `rc_blk${i}`, complianceStatus: 'blocked', complianceReasons: ['Recipient matches a sanctions watchlist.'] }));
    const clock = { t: 5_000_000 };
    evidenceHook.calls = [];
    evidenceHook.before = () => { clock.t += 50; };
    try {
      const r = await reconcileSweep(db, new Date(), { rescreenBudgetMs: 5_000, clock: () => clock.t });
      expect(evidenceHook.calls.filter((id) => id.startsWith('rc_blk'))).toEqual([]);
      expect(r.stuckPaid).toBe(120);
      expect(r.fundingResumed).toBe(1);
      expect(await screens('rc_lv1')).toBe(2);
      expect(logSpy.warn.mock.calls.filter((c) => c[0] === 'reconcile.rescreen-deferred')).toEqual([]);
      // Every stuck row still gets its recon alert.
      expect((await outboxRows()).filter((x) => x.dedupe_key?.startsWith('recon:rc_blk'))).toHaveLength(120);
    } finally {
      evidenceHook.before = null;
    }
  });

  it('K3: 120 stuck http rows whose screen needs no heal (50 ms per evidence read) do not spend the budget', async () => {
    await rail('http');
    await store.saveTransfer(victim());
    await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    // No evidence on file: the instruct gate passes them, so the heal is skipped after one read.
    stuckSnapshot.rows = Array.from({ length: 120 }, (_, i) => fixture({ id: `rc_ok${i}` }));
    const clock = { t: 5_000_000 };
    evidenceHook.calls = [];
    evidenceHook.before = () => { clock.t += 50; };
    try {
      const r = await reconcileSweep(db, new Date(), { rescreenBudgetMs: 5_000, clock: () => clock.t });
      expect(evidenceHook.calls.filter((id) => id.startsWith('rc_ok'))).toHaveLength(120);
      expect(r.fundingResumed).toBe(1);
      expect(await screens('rc_lv1')).toBe(2);
      expect(logSpy.warn.mock.calls.filter((c) => c[0] === 'reconcile.rescreen-deferred')).toEqual([]);
      expect((await outboxRows()).filter((x) => x.dedupe_key?.startsWith('recon:rc_ok'))).toHaveLength(120);
    } finally {
      evidenceHook.before = null;
    }
  });

  it('E4: a victim deferred for lack of budget is logged with counts only (no id, no name)', async () => {
    await rail('http');
    await store.saveTransfer(victim());
    await seedLiveEvidence(db, { id: 'rc_lv1', partnerId: 'acme', recipientName: 'Anita' }, { screenedAgoMs: 40 * 3_600_000 });
    await reconcileSweep(db, new Date(), { rescreenBudgetMs: 0 });
    expect((await store.getTransfer('rc_lv1'))?.status).toBe('awaiting_payment');
    const calls = logSpy.warn.mock.calls.filter((c) => c[0] === 'reconcile.rescreen-deferred');
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ resumeDeferred: 1, healDeferred: 0 });
    expect(JSON.stringify(calls[0])).not.toMatch(/rc_lv1|Anita|1555/);
  });

  it('a stale review waiting on the list says so; any other stale review keeps the usual copy', async () => {
    await store.saveTransfer(fixture({ id: 'rc_lvrev', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LIST_UNAVAILABLE_REASON] }));
    await store.saveTransfer(fixture({ id: 'rc_rev2', status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] }));
    await reconcileSweep(db);
    const listCopy = await message('review:rc_lvrev');
    expect(listCopy).toContain('fresh sanctions list');
    expect(listCopy).toContain('released automatically');
    expect(listCopy).toContain('list loader');
    const usual = await message('review:rc_rev2');
    expect(usual).toContain('release or refund it');
    expect(usual).not.toContain('sanctions list');
  });

  // Review S5 (W2b): a stale review of a row BLOCKED by sanctions screening
  // (the list-hold sweep or the release re-screen matched it; it stays in
  // review) can never be released, and its funds must not be returned before
  // the compliance officer decides: no "release or refund it".
  it('S5 W2b: a stale review of a sanctions-BLOCKED row says so and the no-refund rule; a flagged one keeps "release or refund it."', async () => {
    await store.saveTransfer(fixture({
      id: 'rc_blkrev', status: 'in_review', complianceStatus: 'blocked', complianceReasons: ['Recipient matches a sanctions watchlist.'],
    }));
    await store.saveTransfer(fixture({ id: 'rc_rev3', status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] }));
    await reconcileSweep(db);
    expect(await message('review:rc_blkrev')).toBe(
      '⚠️ SmartRemit ops: transfer rc_blkrev (partner acme) has been in compliance review for >24h — ' +
        `it is blocked by sanctions screening, so it can never be released. ${SANCTIONS_NO_PAYOUT_SENTENCE}; evidence on the compliance page.`,
    );
    expect(await message('review:rc_rev3')).toBe(
      '⚠️ SmartRemit ops: transfer rc_rev3 (partner acme) has been in compliance review for >24h — release or refund it.',
    );
  });

  // Inventory (S5): the crash-resume of a charged row that is BLOCKED (its
  // resume re-screen matched, or it was already compliance-blocked) never says
  // to refund it at the funding provider.
  it('S5: a charged victim already compliance-BLOCKED (settleOrHold refused): fundblocked has the no-refund rule, never "refund at the funding provider"', async () => {
    await rail('mock');
    await store.saveTransfer(victim({ complianceStatus: 'blocked', complianceReasons: ['Recipient matches a sanctions watchlist.'] }));
    await reconcileSweep(db);
    expect((await store.getTransfer('rc_lv1'))?.status).toBe('awaiting_payment');
    expect(await message('fundblocked:rc_lv1')).toBe(
      '⚠️ SmartRemit ops: transfer rc_lv1 (partner acme) was charged (mockfund-rc_lv1) but never settled — ' +
        `it is BLOCKED by sanctions screening and was CHARGED. NOT settled. ${SANCTIONS_NO_PAYOUT_SENTENCE}. ` +
        'No dashboard action applies: once the compliance officer has decided, record the outcome with a direct ledger edit under a change ticket.',
    );
  });
});

// Fix pack 2 T4 (R02): every full sweep re-screens the LIST_UNAVAILABLE holds
// (list-hold-rescreen.ts) in its own try/catch.
describe('reconcileSweep — list-outage holds (fix pack 2 T4)', { retry: 0 }, () => {
  const held = (id: string) =>
    fixture({
      id, status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LIST_UNAVAILABLE_REASON],
      createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 1_800_000).toISOString(),
    });

  it('runs the list-hold sweep; a sweep throw does not fail the others; listHoldsReleased reported', async () => {
    // A mock-rail hold on the (mock) demo list: released by the re-screen.
    await store.saveTransfer(held('rc_lh1'));
    const r = await reconcileSweep(db);
    expect(r.listHoldsReleased).toBe(1);
    expect((await store.getTransfer('rc_lh1'))?.status).toBe('paid');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toContain('mocksettle:rc_lh1');

    // A throwing sweep costs only itself: the stuck-paid sweep still alerts.
    listSweepThrows.value = true;
    await store.saveTransfer(held('rc_lh2'));
    await store.saveTransfer(fixture({ id: 'rc_stuck', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
    const r2 = await reconcileSweep(db);
    expect(r2.listHoldsReleased).toBe(0);
    expect(r2.stuckPaid).toBeGreaterThanOrEqual(1);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toContain('recon:rc_stuck');
    expect((await store.getTransfer('rc_lh2'))?.status).toBe('in_review');
  });
});
