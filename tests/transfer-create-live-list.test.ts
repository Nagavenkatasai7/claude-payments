import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, MintRefusedError } from '@/lib/transfer-create';
import { createStore, type SenderLedgerOps } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { settleOrHold } from '@/lib/settlement';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import { LIST_UNAVAILABLE_REASON, RECIPIENT_WATCHLIST_REASON } from '@/lib/compliance-config';
import { listNotLiveDedupeKey } from '@/lib/sanctions/list-health';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner, seedSender } from './helpers-db';
import { primeListSet, primeOfacSource, restoreOfacSource } from './helpers-sanctions';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { ScreeningEvidence } from '@/lib/sanctions/evidence';

// Fix pack 2 T2 (R02): the mint-time live-list gate. A real-money mint (an
// `http` rail on the SETTLEMENT partner, environment not 'test') clears only on
// an OFAC SDN list checked within 36 h; otherwise it is held (flagged,
// LIST_UNAVAILABLE first) and one ops.alert per Eastern day is queued with it.
// Demo, default tenant, simulator, mock and sandbox mints are unchanged.

const PHONE = '15550100077';
const HOUR = 3_600_000;
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;

beforeEach(() => {
  delete process.env.SANCTIONS_LIST; // the mock list (production today)
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  restoreOfacSource(ORIGINAL_LIST);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function makeStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  return {
    db,
    store: createStore(redis, db),
    partnerStore: createPartnerStore(db),
    mvs: createMonthlyVolumeStore(createStore(redis, db)),
  };
}

async function setRail(db: Db, partnerId: string, providerType: string) {
  await db.execute(sql`
    INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES (${partnerId}, ${providerType})
    ON CONFLICT (partner_id) DO UPDATE SET payment_provider_type = ${providerType}`);
}

/** A partner with a rail of `rail` (none = no integrations row) and a seasoned sender. */
async function partnerWith(db: Db, id: string, rail?: string) {
  await seedPartner(db, id);
  if (rail) await setRail(db, id, rail);
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base = {
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000077',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

const quote = {
  amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
  amountSource: 200, feeSource: 0, totalChargeSource: 200,
};

async function listAlerts(db: Db) {
  const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' AND dedupe_key LIKE 'sanctions-list-not-live:%'`);
  return r.rows as Array<{ dedupe_key: string; payload: Record<string, unknown> }>;
}

async function outboxCount(db: Db) {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM outbox`);
  return Number((r.rows[0] as { n: number }).n);
}

async function evidenceRows(db: Db, id: string) {
  const r = await db.execute(sql`SELECT meta FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id}`);
  return (r.rows as Array<{ meta: ScreeningEvidence }>).map((x) => x.meta);
}

/** partner_integrations statements issued BEFORE the sender lock (the pre-lock rail read). */
function preLockRailReads(log: Array<{ sql: string }>): string[] {
  const sqls = log.map((q) => q.sql.toLowerCase());
  const lock = sqls.findIndex((q) => q.includes("set local lock_timeout"));
  return sqls.slice(0, lock < 0 ? sqls.length : lock).filter((q) => q.includes('partner_integrations'));
}

describe('mint live-list gate — real-money rails (fix pack 2 R02)', { retry: 0 }, () => {
  it('http partner, live, mock list, UNROUTED: flagged LIST_UNAVAILABLE, awaiting_payment; settleOrHold -> in_review; one ops.alert; a second mint the same day -> still one alert', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons[0]).toBe(LIST_UNAVAILABLE_REASON);
    expect(t.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(t.status).toBe('awaiting_payment');
    const [ev] = await evidenceRows(db, t.id);
    expect(ev).toMatchObject({ decision: 'list_unavailable', listFitness: 'not_live', listSource: 'mock-watchlist' });
    const stored = await createTransferRepo(db).getTransfer(t.id);
    expect(await settleOrHold(db, stored!, EMPTY_PARTNER_INTEGRATIONS)).toEqual({ kind: 'held' });
    expect((await createTransferRepo(db).getTransfer(t.id))?.status).toBe('in_review');

    const a = await listAlerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(listNotLiveDedupeKey(new Date()));
    expect(Object.keys(a[0].payload)).toEqual(['message']);
    expect(String(a[0].payload.message)).toContain('partner acme');
    expect(String(a[0].payload.message)).not.toContain(PHONE);
    expect(String(a[0].payload.message)).not.toContain('Mom');

    const t2 = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', amountSource: 50 });
    expect(t2.complianceStatus).toBe('flagged');
    expect(await listAlerts(db)).toHaveLength(1);
  });

  it('fresh ofac -> cleared, evidence listFitness live', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    primeOfacSource({ checkedAgoMs: HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    const [ev] = await evidenceRows(db, t.id);
    expect(ev).toMatchObject({ decision: 'clear', listFitness: 'live', listSource: 'ofac-sdn' });
    expect(ev.listCheckedAt).toBeDefined();
    expect(await listAlerts(db)).toEqual([]);
  });

  it('fix pack 5 T29: SANCTIONS_LIST=lists, every list live, a real-money mint to IN -> cleared on the four-list floor (lists.length 4, set fitness live)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme');
    primeListSet({});
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', destinationCountry: 'IN' });
    expect(t.complianceStatus).toBe('cleared');
    const [ev] = await evidenceRows(db, t.id);
    expect(ev).toMatchObject({ decision: 'clear', listFitness: 'live', listSource: 'lists:ofac-sdn+ofac-cons+un-sc+in-mha-uapa' });
    expect(ev.lists).toHaveLength(4);
    expect(await listAlerts(db)).toEqual([]);
  });

  it('checked 37 h ago -> held, stale', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    primeOfacSource({ checkedAgoMs: 37 * HOUR });
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    const [ev] = await evidenceRows(db, t.id);
    expect(ev).toMatchObject({ decision: 'list_unavailable', listFitness: 'stale' });
    expect(await listAlerts(db)).toHaveLength(1);
  });

  it('default owner + approved quote routed to an http partner -> refused default_on_live_rail, nothing written (fix pack 3 T4)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    await seedPartner(db, 'railco');
    await setRail(db, 'railco', 'http');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await outboxCount(db);
    const err = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', quote, settlementPartnerId: 'railco' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MintRefusedError);
    expect((err as MintRefusedError).code).toBe('default_on_live_rail');
    expect(await outboxCount(db)).toBe(before);
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM transfers`);
    expect(Number((n.rows[0] as { n: number }).n)).toBe(0);
    expect(await listAlerts(db)).toEqual([]);
  });

  it('same without a quote (route dropped) -> cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    await seedPartner(db, 'railco');
    await setRail(db, 'railco', 'http');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', settlementPartnerId: 'railco' });
    expect(t.settlementPartnerId).toBeUndefined();
    expect(t.complianceStatus).toBe('cleared');
    expect(await listAlerts(db)).toEqual([]);
  });

  it('http owner routed to a simulator partner -> cleared', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    await seedPartner(db, 'simco');
    await setRail(db, 'simco', 'simulator');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'simco' });
    expect(t.complianceStatus).toBe('cleared');
    expect(await listAlerts(db)).toEqual([]);
  });

  it('rail read fails -> held on the mock list, cleared on a fresh one', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'simco', 'simulator');
    // Fix pack 3 T4: a failed rail read is real money, so the owner must be certified to mint.
    await certifyPartnerForTest(db, 'simco');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      const held = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco' });
      expect(held.complianceStatus).toBe('flagged');
      expect(held.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
      primeOfacSource({ checkedAgoMs: HOUR });
      const cleared = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco', amountSource: 50 });
      expect(cleared.complianceStatus).toBe('cleared');
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
  });

  it('\'test blocked\' on http -> blocked, no list alert', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', recipientName: 'test blocked' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(await listAlerts(db)).toEqual([]);
  });

  it('blocked http mint writes notices in the mint tx; a later throw in the mint rolls them back', async () => {
    // Fix pack 2 T5 (R04): the sanctions.block audit, the ops alert and the
    // partner email commit with the blocked row, or not at all.
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    primeOfacSource({ checkedAgoMs: HOUR });
    const notices = async () => (await db.execute(sql`
      SELECT kind, dedupe_key FROM outbox WHERE dedupe_key LIKE 'sanctionsblock%' ORDER BY id`)).rows as Array<{ kind: string; dedupe_key: string }>;
    const blockAudits = async () => (await db.execute(sql`
      SELECT subject_id, meta FROM audit_events WHERE action = 'sanctions.block' ORDER BY id`)).rows as Array<{ subject_id: string; meta: Record<string, unknown> }>;

    const real = store.mintUnderSenderLock.bind(store);
    const spy = vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
      real(p, ph, async (ops) => {
        await fn(ops);
        throw new Error('later step failed');
      })) as typeof store.mintUnderSenderLock);
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_block_rb', recipientName: 'Testa Fixturelli' }))
      .rejects.toThrow('later step failed');
    expect(await notices()).toEqual([]);
    expect(await blockAudits()).toEqual([]);
    spy.mockRestore();

    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_block_ok', recipientName: 'Testa Fixturelli' });
    expect(t.complianceStatus).toBe('blocked');
    expect(await notices()).toEqual([
      { kind: 'ops.alert', dedupe_key: 'sanctionsblock:tr_block_ok' },
      { kind: 'email.send', dedupe_key: 'sanctionsblockmail:tr_block_ok:acme' },
    ]);
    const audits = await blockAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subject_id: 'tr_block_ok', meta: { stage: 'mint', environment: 'live', realMoney: true, quiet: false } });
  });

  it("'test blocked' on a simulator mint -> a quiet sanctions.block audit only", async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'simco', 'simulator');
    const before = await outboxCount(db);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco', recipientName: 'test blocked' });
    expect(t.complianceStatus).toBe('blocked');
    expect(await outboxCount(db)).toBe(before);
    const r = await db.execute(sql`SELECT meta FROM audit_events WHERE action = 'sanctions.block' AND subject_id = ${t.id}`);
    expect((r.rows as Array<{ meta: Record<string, unknown> }>).map((x) => x.meta)).toMatchObject([{ stage: 'mint', quiet: true, realMoney: false }]);
  });

  it('a same-id replay -> no second evidence row, no alert', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    const real = store.mintUnderSenderLock.bind(store);
    let alertCalls = 0;
    vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
      real(p, ph, (ops) => fn({
        ...ops,
        enqueueListNotLiveAlert: async () => { alertCalls++; await ops.enqueueListNotLiveAlert(); },
      }))) as typeof store.mintUnderSenderLock);
    const first = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_live_replay' });
    expect(first.complianceStatus).toBe('flagged');
    expect(alertCalls).toBe(1);
    const again = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_live_replay' });
    expect(again.id).toBe('tr_live_replay');
    expect(alertCalls).toBe(1);
    expect(await evidenceRows(db, 'tr_live_replay')).toHaveLength(1);
    expect(await listAlerts(db)).toHaveLength(1);
  });
});

describe('mint live-list gate — demo paths unchanged (fix pack 2 R02)', { retry: 0 }, () => {
  it('environment \'test\' on an http partner -> cleared, zero pre-lock rail reads', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', environment: 'test' });
    const log = stop();
    expect(t.complianceStatus).toBe('cleared');
    expect(preLockRailReads(log)).toEqual([]);
    expect(await listAlerts(db)).toEqual([]);
  });

  it('a live http mint makes exactly ONE pre-lock rail read', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme'); // fix pack 3 T4: live http mints need a certified rail
    primeOfacSource({ checkedAgoMs: HOUR });
    const stop = captureQueries();
    await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(preLockRailReads(stop())).toHaveLength(1);
  });

  it.each([
    ['simulator', 'simco', 'simulator'],
    ['mock', 'mockco', 'mock'],
    ['no row', 'bare', undefined],
  ] as const)('%s rail -> cleared, no alert, no new outbox rows', async (_label, id, rail) => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, id, rail);
    const before = await outboxCount(db);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: id });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    expect(await outboxCount(db)).toBe(before);
    const [ev] = await evidenceRows(db, t.id);
    expect(ev).toMatchObject({ decision: 'clear', listFitness: 'not_live' });
  });

  it('default tenant -> cleared, no alert, no new outbox rows', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    const before = await outboxCount(db);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default' });
    expect(t.complianceStatus).toBe('cleared');
    expect(await outboxCount(db)).toBe(before);
  });
});
