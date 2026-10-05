import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep } from '@/lib/reconcile';
import { invalidateFlagCache, SETTLEMENT_PAUSED_DEFER_SEC } from '@/lib/flags';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Release safety Batch 2 part A: the settlement.paused kill switch. A paused
// settlement.instruct row is deferred UNCHARGED (no POST, no attempt spent, no
// dead letter); the reconcile sweep neither re-instructs nor alerts a paused
// transfer as stuck.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'sp_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(): WorkerDeps {
  return {
    db,
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

const rail = (url: string) => ({
  kyc: {},
  payment: { providerType: 'http' as const, credentials: { settlementUrl: url, signingSecret: 'sgn' }, webhookSecret: 'whk' },
  whatsapp: {},
});

async function pause(scopeType: 'global' | 'partner' | 'corridor', scopeId: string, enabled = true) {
  await createFeatureFlagRepo(db).upsert({ key: 'settlement.paused', scopeType, scopeId, enabled, reason: 'rail incident', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

type RowState = { status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE kind = 'settlement.instruct'`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}

async function opsAlerts(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string }>;
  };
  return r.rows.map((x) => x.k);
}

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
  await store.saveTransfer(transferFixture());
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('https://rail.example/settle'));
});
afterEach(() => invalidateFlagCache(db));

describe('settlement.instruct under settlement.paused', { retry: 0 }, () => {
  it('a global pause defers the row uncharged: no POST, attempts 0, due in ~5 minutes, counted as released', async () => {
    await pause('global', '');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'instruct:sp_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ processed: 0, failed: 0, released: 1 });
    const st = await rowState();
    expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(st.backoff_s).toBeGreaterThanOrEqual(SETTLEMENT_PAUSED_DEFER_SEC - 5);
    expect(st.backoff_s).toBeLessThanOrEqual(SETTLEMENT_PAUSED_DEFER_SEC + 5);
    expect(await opsAlerts()).toEqual([]); // no railfail / dead alert
  });

  it('once the pause is off the same row is POSTed and done', async () => {
    await pause('global', '');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'instruct:sp_t1' });
    await drainOnce(deps(), 'w1');
    await pause('global', '', false);
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.processed).toBe(1);
    expect((await rowState()).status).toBe('done');
  });

  it('a pause on the ROUTED rail partner defers the row; a pause on another partner does not', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer(transferFixture({ settlementPartnerId: 'railp' }));
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', rail('https://railp.example/settle'));
    await pause('partner', 'globex');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'instruct:sp_t1' });
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1); // another partner's pause changes nothing

    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'reinstruct:sp_t1' });
    await pause('partner', 'railp');
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.released).toBe(1);
  });

  it('a corridor pause defers only that destination country', async () => {
    await pause('corridor', 'PH');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'instruct:sp_t1' });
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1); // IN is not paused

    await pause('corridor', 'IN');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'reinstruct:sp_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.released).toBe(1);
  });

  it('a not-payable row (cancelled) still finishes as before, even while paused', async () => {
    await store.saveTransfer(transferFixture({ status: 'cancelled' }));
    await pause('global', '');
    await outbox.enqueue('settlement.instruct', { transferId: 'sp_t1' }, { dedupeKey: 'instruct:sp_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect((await rowState()).status).toBe('done');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('reconcileSweep under settlement.paused', { retry: 0 }, () => {
  it('a stuck paid transfer whose settlement is paused is neither re-instructed nor alerted', async () => {
    await pause('partner', 'acme');
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect(await opsAlerts()).toEqual([]);
    const instr = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'settlement.instruct'`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    expect(Number(instr.rows[0].n)).toBe(0);
  });

  it('without the pause the same transfer is re-instructed once and alerted (unchanged behaviour)', async () => {
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(1);
    expect(await opsAlerts()).toContain('recon:sp_t1');
  });
});
