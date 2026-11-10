import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { updateLiveControlsKey } from '@/db/repos/partner-repo';
import {
  drainOnce,
  INSTRUCT_NOT_CERTIFIED_DEFER_SEC,
  type WorkerDeps,
} from '@/lib/outbox-worker';
import { reconcileSweep } from '@/lib/reconcile';
import { invalidateFlagCache, SETTLEMENT_PAUSED_DEFER_SEC } from '@/lib/flags';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { env } from '@/lib/env';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 3 T6 (R15, contract 7 step 11): a paid live row on a real-money
// (http) rail whose RAIL partner is not certified for live money (or whose
// owner is the default tenant) is never POSTed. The worker defers it UNCHARGED
// every 15 minutes with ONE `livegate:<id>` ops alert (never the attempt
// budget, never a dead letter, never railfail); the reconcile stuck-paid loop
// skips it. Not real money (simulator, mock, sandbox) is unchanged.

// A switch that makes the DB partner read throw (fail closed: not certified).
const partnerFail = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (dbx: Parameters<typeof real.createPartnerRepo>[0]) => {
      const r = real.createPartnerRepo(dbx);
      return {
        ...r,
        getPartner: async (id: string) => {
          if (partnerFail.on) throw new Error('partner read failed');
          return r.getPartner(id);
        },
      };
    },
  };
});

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'lg_t1';
const STORED = 'https://rail.example/settle';
const H = 3_600_000;
const originalList = process.env.SANCTIONS_LIST;

const livegateText = (id: string, rail: string) =>
  `transfer ${id} (rail ${rail}) is paid but was not instructed: the rail partner is not certified for live money. ` +
  'It waits; certify the partner or cancel and refund it.';

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
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

function rail(providerType: string, url: string | null = STORED) {
  const credentials: Record<string, string> = url === null ? { signingSecret: 'sgn' } : { settlementUrl: url, signingSecret: 'sgn' };
  return {
    kyc: {},
    payment: {
      providerType,
      credentials,
      webhookSecret: 'whk',
    },
    whatsapp: {},
  };
}
async function saveRail(partnerId: string, providerType: string, url: string | null = STORED) {
  await createIntegrationsRepo(db, provider).saveIntegrations(partnerId, rail(providerType, url));
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
async function alertText(key: string): Promise<string> {
  const r = (await db.execute(sql`SELECT payload->>'message' AS m FROM outbox WHERE dedupe_key = ${key}`)) as unknown as {
    rows: Array<{ m: string }>;
  };
  expect(r.rows).toHaveLength(1);
  return r.rows[0].m;
}
async function count(q: ReturnType<typeof sql>): Promise<number> {
  const r = (await db.execute(q)) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}
/** Replace the beforeEach row (an upsert may keep insert-only columns such as the owner or environment). */
async function replaceTransfer(over: Partial<Transfer>) {
  await db.execute(sql`DELETE FROM transfers WHERE id = ${ID}`);
  await store.saveTransfer(transferFixture(over));
}
const dueNow = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });

// A re-drain also delivers the livegate ops.alert the first drain queued
// (processed 1); the instruct row itself is only ever released.
async function expectDeferred(r: Awaited<ReturnType<typeof drainOnce>>, processed = 0) {
  expect(fetchFn).not.toHaveBeenCalled();
  expect(r).toMatchObject({ processed, failed: 0, released: 1 });
  const st = await rowState();
  expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  expect(st.backoff_s).toBeGreaterThanOrEqual(INSTRUCT_NOT_CERTIFIED_DEFER_SEC - 5);
  expect(st.backoff_s).toBeLessThanOrEqual(INSTRUCT_NOT_CERTIFIED_DEFER_SEC + 5);
}

beforeEach(async () => {
  partnerFail.on = false;
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
  await store.saveTransfer(transferFixture());
  await saveRail('acme', 'http');
});
afterEach(() => {
  invalidateFlagCache(db);
  restoreOfacSource(originalList);
});

describe('settlement.instruct and the live-certification gate (pack 3 T6)', { retry: 0 }, () => {
  it('uncertified http rail: no POST, deferred uncharged ~900 s, released 1, one livegate alert', async () => {
    expect(INSTRUCT_NOT_CERTIFIED_DEFER_SEC).toBe(900);
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
    expect(await alertText(`livegate:${ID}`)).toBe(livegateText(ID, 'acme'));
  });

  it('drained again after the deferral: still one livegate alert, still attempts 0', async () => {
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    await dueNow();
    await expectDeferred(await drainOnce(deps(), 'w1'), 1);
    await dueNow();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
  });

  it('certified http rail: POSTed and done, no livegate alert', async () => {
    await certifyPartnerForTest(db, 'acme');
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(STORED);
    expect((await rowState()).status).toBe('done');
    expect((await opsAlerts()).filter((k) => k.startsWith('livegate:'))).toEqual([]);
  });

  it('routed: the RAIL partner decides', async () => {
    const RAILP = 'https://railp.example/settle';
    await certifyPartnerForTest(db, 'acme');
    await seedPartner(db, 'railp');
    await saveRail('railp', 'http', RAILP);
    await store.saveTransfer(transferFixture({ settlementPartnerId: 'railp' }));
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
    expect(await alertText(`livegate:${ID}`)).toBe(livegateText(ID, 'railp'));

    await certifyPartnerForTest(db, 'railp');
    await dueNow();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 2, failed: 0, released: 0 }); // the instruct + the queued livegate alert
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(RAILP);
    expect((await rowState()).status).toBe('done');
  });

  it("owner 'default' routed to a certified http rail -> deferred (default_on_live_rail), same alert text", async () => {
    await certifyPartnerForTest(db, 'acme');
    await replaceTransfer({ partnerId: 'default', settlementPartnerId: 'acme' });
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
    expect(await alertText(`livegate:${ID}`)).toBe(livegateText(ID, 'acme'));
  });

  it('revoked certification -> deferred', async () => {
    await certifyPartnerForTest(db, 'acme');
    await updateLiveControlsKey(
      'acme',
      'certification',
      (prev: unknown) => ({ ...(prev as Record<string, unknown>), revokedAt: new Date().toISOString(), revokedBy: 'test-admin' }),
      db,
    );
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
  });

  it('rail partner read throws -> deferred (fail closed)', async () => {
    await certifyPartnerForTest(db, 'acme');
    partnerFail.on = true;
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    expect(await opsAlerts()).toEqual([`livegate:${ID}`]);
  });

  it('uncertified simulator rail -> POSTed to the hosted rail (not real money)', async () => {
    await saveRail('acme', 'simulator');
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`${env.appBaseUrl}/api/partner-rail`);
    expect(await opsAlerts()).toEqual([]);
  });

  it.each([['mock'], ['no integrations row']])('uncertified %s rail -> unchanged (no livegate alert)', async (kind) => {
    if (kind === 'mock') await saveRail('acme', 'mock');
    else await db.execute(sql`DELETE FROM partner_integrations WHERE partner_id = 'acme'`);
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(r.released).toBe(0);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`${env.appBaseUrl}/api/partner-rail`);
    expect((await opsAlerts()).filter((k) => k.startsWith('livegate:'))).toEqual([]);
  });

  it('sandbox row on an uncertified http rail -> sandboxinstruct alert only, no livegate alert', async () => {
    await replaceTransfer({ environment: 'test' } as Partial<Transfer>);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await opsAlerts()).toEqual([`sandboxinstruct:${ID}`]);
  });

  it('cancelled row -> done, no livegate alert', async () => {
    await store.saveTransfer(transferFixture({ status: 'cancelled' }));
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect((await rowState()).status).toBe('done');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await opsAlerts()).toEqual([]);
  });

  it('settlement.paused on + uncertified -> SettlementPausedError (300 s), no livegate alert', async () => {
    await createFeatureFlagRepo(db).upsert({ key: 'settlement.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'rail incident', updatedBy: 'admin' });
    invalidateFlagCache(db);
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ processed: 0, failed: 0, released: 1 });
    const st = await rowState();
    expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(st.backoff_s).toBeGreaterThanOrEqual(SETTLEMENT_PAUSED_DEFER_SEC - 5);
    expect(st.backoff_s).toBeLessThanOrEqual(SETTLEMENT_PAUSED_DEFER_SEC + 5);
    expect(await opsAlerts()).toEqual([]);
  });

  it('uncertified http rail with NO settlement URL -> livegate deferral, never RailInstructError', async () => {
    await saveRail('acme', 'http', null);
    await enqueueInstruct();
    await expectDeferred(await drainOnce(deps(), 'w1'));
    const keys = await opsAlerts();
    expect(keys).toEqual([`livegate:${ID}`]);
    expect(keys.filter((k) => k.startsWith('railfail:'))).toEqual([]);
  });

  it('certified http rail, newest evidence stale -> instructnotlive and InstructNotLiveError as before', async () => {
    await certifyPartnerForTest(db, 'acme');
    const t = transferFixture();
    await seedLiveEvidence(db, { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName }, { screenedAgoMs: 40 * H });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    const st = await rowState();
    expect(st.status).toBe('failed');
    expect(st.attempts).toBe(1);
    expect(st.last_error).toBe('Last screen older than the list age limit.');
    expect(await opsAlerts()).toEqual([`instructnotlive:${ID}`]);
  });
});

describe('reconcileSweep and the live gate', { retry: 0 }, () => {
  const instructRows = () => count(sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'settlement.instruct'`);
  const screens = () => count(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${ID}`);

  it('uncertified http rail: skipped - reinstructed 0, no reinstruct: row, no recon: alert, no sanctions.screen audit row; with no live instruct row, one livegate:stuck: alert (pack 3 review I1)', async () => {
    // A 40 h old live screen and a live list: the stuck-paid heal WOULD re-screen this row.
    primeOfacSource({ checkedAgoMs: H });
    const t = transferFixture();
    await seedLiveEvidence(db, { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName }, { screenedAgoMs: 40 * H });
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect(await instructRows()).toBe(0);
    expect(await opsAlerts()).toEqual([`livegate:stuck:${ID}`]);
    expect(await screens()).toBe(1); // only the seeded one
  });

  it('certified http rail: re-instructed once and alerted, as before (and the heal re-screens it)', async () => {
    await certifyPartnerForTest(db, 'acme');
    primeOfacSource({ checkedAgoMs: H });
    const t = transferFixture();
    await seedLiveEvidence(db, { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName }, { screenedAgoMs: 40 * H });
    const r = await reconcileSweep(db);
    expect(await screens()).toBe(2); // the contrast for the skip above: the heal ran
    expect(r.reinstructed).toBe(1);
    expect(await instructRows()).toBe(1);
    expect(await opsAlerts()).toContain(`recon:${ID}`);
  });

  it('uncertified simulator rail: re-instructed once and alerted (unchanged)', async () => {
    await saveRail('acme', 'simulator');
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(1);
    expect(await opsAlerts()).toContain(`recon:${ID}`);
  });
});
