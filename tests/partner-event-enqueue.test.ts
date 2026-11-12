import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, type CreateTransferInput } from '@/lib/transfer-create';
import { createStore, type SenderLedgerOps } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { rescreenBeforePay } from '@/lib/pay-rescreen';
import { releaseHoldAfterRescreen, releaseRescreenedHold } from '@/lib/settlement';
import { releaseTransfer } from '@/lib/dashboard-ops';
import { resolveCorridorRules, LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON } from '@/lib/compliance-config';
import { SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import type { ComplianceResult } from '@/lib/compliance';
import type { ScreeningEvidence, SanctionsDecision } from '@/lib/sanctions/evidence';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner, seedSender } from './helpers-db';
import { certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';
import { heldRowFor, platformReviewFor } from './helpers-hold';
import { seedLiveEvidence } from './helpers-sanctions';

// Fix pack 7 T22 (P21 sites 1-4): a list screen whose decision is exactly
// 'possible_match' on a live row of a live-certified OWNER queues ONE
// partner.event row of type screening.potential_match, in the transaction that
// records the hold: the mint, the pay-time re-screen, the automatic list sweep
// (still held) and the staff release re-screen (held). The dedupe key is global
// and for ever. list_unavailable, match and clear never queue one; neither does
// an uncertified owner, the default tenant or a sandbox ('test') row.

const pokes = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { pokes.n++; } };
});

// Counted (and optionally failing) owner reads through createPartnerRepo(...).getPartner.
const partnerReads = vi.hoisted(() => ({ n: 0, fail: false }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const r = real.createPartnerRepo(...a);
      const get = r.getPartner.bind(r);
      r.getPartner = async (id) => {
        partnerReads.n++;
        if (partnerReads.fail) throw new Error('partner read failed');
        return get(id);
      };
      return r;
    },
  };
});

// The mock list never returns a possible match: the screener is switchable per test.
let screenerMode: 'real' | 'possible' | 'unavailable' = 'real';
vi.mock('@/lib/providers/sanctions-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/sanctions-provider')>();
  return {
    ...real,
    getSanctionsScreener: (...a: Parameters<typeof real.getSanctionsScreener>) => {
      if (screenerMode === 'real') return real.getSanctionsScreener(...a);
      return {
        listInfo: () => ({ source: 'test-list', version: 't1', hash: 'h' }),
        screen: async () => {
          if (screenerMode === 'unavailable') throw new SanctionsListUnavailableError();
          return { matched: false, possibleMatch: true, matchScore: 0.9, entryId: 'test:1' };
        },
      };
    },
  };
});

const PHONE = '15550100322';
const H = 3_600_000;
const REL = { actor: 'plat', reason: 'checked the hold' };

beforeEach(() => {
  pokes.n = 0;
  partnerReads.n = 0;
  partnerReads.fail = false;
  screenerMode = 'real';
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
type Stores = Awaited<ReturnType<typeof makeStores>>;

/** A partner on the mock rail (no integrations row: not real money) with a seasoned sender. */
async function mockRailPartner(db: Db, id: string, o: { certify?: boolean } = {}) {
  await seedPartner(db, id);
  if (o.certify) await certifyPartnerForTest(db, id);
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base: Omit<CreateTransferInput, 'partnerId'> = {
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD',
  recipientName: 'Mom',
  recipientPhone: '919000000322',
  payoutMethod: 'upi',
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer',
  senderKycStatus: 'verified',
};
const quote = {
  amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
  amountSource: 200, feeSource: 0, totalChargeSource: 200,
};

type EventRow = { payload: Record<string, unknown>; dedupe_key: string };
async function eventRows(db: Db): Promise<EventRow[]> {
  const r = await db.execute(sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'partner.event' ORDER BY id`);
  return r.rows as EventRow[];
}
async function counts(db: Db) {
  const n = async (table: string) =>
    Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n);
  return { transfers: await n('transfers'), outbox: await n('outbox'), audit: await n('audit_events') };
}
async function screenRows(db: Db, id: string): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id}`);
  return Number((r.rows[0] as { n: number }).n);
}

function expectOneEvent(rows: EventRow[], transferId: string) {
  expect(rows.map((r) => r.dedupe_key)).toEqual([`screening.potential_match:${transferId}`]);
  expect(Object.keys(rows[0].payload).sort()).toEqual(['eventId', 'transferId', 'type']);
  expect(rows[0].payload).toMatchObject({ type: 'screening.potential_match', transferId });
  expect(typeof rows[0].payload.eventId).toBe('string');
}

/** Run the mint with the lock's ops replaced by `wrap(ops)`. */
function wrapOps(store: Stores['store'], wrap: (ops: SenderLedgerOps) => SenderLedgerOps) {
  const real = store.mintUnderSenderLock.bind(store);
  return vi.spyOn(store, 'mintUnderSenderLock').mockImplementation(((p: string, ph: string, fn: (ops: SenderLedgerOps) => Promise<unknown>) =>
    real(p, ph, (ops) => fn(wrap(ops)))) as typeof store.mintUnderSenderLock);
}

function lockedStatements(log: Array<{ sql: string }>): string[] {
  const sqls = log.map((q) => q.sql.toLowerCase());
  const lock = sqls.findIndex((q) => q.includes('set local lock_timeout'));
  return lock < 0 ? [] : sqls.slice(lock);
}

function evidence(decision: SanctionsDecision): ScreeningEvidence {
  return {
    listSource: 'ofac-sdn',
    listVersion: 'test-version',
    listHash: 'a'.repeat(64),
    screenedAt: new Date().toISOString(),
    decision,
    parties: [{ role: 'recipient', inputHash: 'b'.repeat(64), matched: false, matchScore: decision === 'possible_match' ? 0.9 : 0 }],
    listFitness: 'live',
  };
}
const possibleResult = (): ComplianceResult => ({ status: 'flagged', reasons: [POSSIBLE_MATCH_REASON], evidence: evidence('possible_match') });

describe('mint (P21 site 1)', { retry: 0 }, () => {
  it('certified owner, live b2c, possible match -> awaiting_payment flagged; ONE partner.event row; poked once', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    screenerMode = 'possible';
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_mint' });
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('flagged');
    expectOneEvent(await eventRows(db), 'tr_pm_mint');
    expect(pokes.n).toBe(1);
  });

  it('the event commits with the row: a failing recordPotentialMatch rolls back the transfer, audits and outbox', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    screenerMode = 'possible';
    const before = await counts(db);
    wrapOps(store, (ops) => ({ ...ops, recordPotentialMatch: async () => { throw new Error('event insert failed'); } }));
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_rb' })).rejects.toThrow('event insert failed');
    expect(await counts(db)).toEqual(before);
  });

  it('no event for an uncertified owner, the default tenant, a sandbox mint, a list_unavailable screen, a clear screen, a blocked mint', async () => {
    const cases: Array<{ name: string; setup: (db: Db) => Promise<void>; partnerId: string; mode: typeof screenerMode; extra?: Partial<CreateTransferInput> }> = [
      { name: 'uncertified', setup: (db) => mockRailPartner(db, 'beta'), partnerId: 'beta', mode: 'possible' },
      {
        name: 'default tenant',
        setup: async (db) => {
          await certifyPartnerForTest(db, 'default'); // isLiveCertified refuses the default id anyway
          await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
        },
        partnerId: 'default',
        mode: 'possible',
      },
      { name: 'sandbox', setup: (db) => mockRailPartner(db, 'acme', { certify: true }), partnerId: 'acme', mode: 'possible', extra: { environment: 'test' } },
      { name: 'list unavailable', setup: (db) => mockRailPartner(db, 'acme', { certify: true }), partnerId: 'acme', mode: 'unavailable' },
      { name: 'clear', setup: (db) => mockRailPartner(db, 'acme', { certify: true }), partnerId: 'acme', mode: 'real' },
      {
        name: 'blocked', setup: (db) => mockRailPartner(db, 'acme', { certify: true }), partnerId: 'acme', mode: 'real',
        extra: { recipientName: 'test blocked' },
      },
    ];
    for (const c of cases) {
      const { db, store, partnerStore, mvs } = await makeStores();
      await c.setup(db);
      screenerMode = c.mode;
      pokes.n = 0;
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: c.partnerId, ...c.extra });
      if (c.name === 'blocked') expect(t.complianceStatus, c.name).toBe('blocked');
      if (c.name === 'clear') expect(t.complianceStatus, c.name).toBe('cleared');
      if (c.name === 'list unavailable' || c.name === 'uncertified' || c.name === 'sandbox') expect(t.complianceStatus, c.name).toBe('flagged');
      expect(await eventRows(db), c.name).toEqual([]);
      if (c.name !== 'blocked') expect(pokes.n, c.name).toBe(0);
    }
  });

  it("an uncertified owner's mint runs no extra statement under the lock (the certified one adds exactly the outbox insert)", async () => {
    screenerMode = 'possible';
    const run = async (certify: boolean) => {
      const { db, store, partnerStore, mvs } = await makeStores();
      await mockRailPartner(db, 'acme', { certify });
      const stop = captureQueries();
      await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_count' });
      return lockedStatements(stop());
    };
    const plain = await run(false);
    const certified = await run(true);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.filter((s) => s.includes('"partners"'))).toEqual([]);
    expect(certified.filter((s) => s.includes('"partners"'))).toEqual([]);
    expect(certified.length - plain.length).toBe(1);
    const extra = certified.filter((s) => s.includes('insert into "outbox"')).length - plain.filter((s) => s.includes('insert into "outbox"')).length;
    expect(extra).toBe(1);
  });

  it('routed rows: the OWNER decides (certified rail with an uncertified owner -> none; certified owner on an uncertified rail -> one)', async () => {
    screenerMode = 'possible';
    {
      const { db, store, partnerStore, mvs } = await makeStores();
      await mockRailPartner(db, 'acme');
      await seedPartner(db, 'railx');
      await certifyPartnerForTest(db, 'railx');
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_r1', quote, settlementPartnerId: 'railx' });
      expect(t.settlementPartnerId).toBe('railx');
      expect(await eventRows(db)).toEqual([]);
    }
    {
      const { db, store, partnerStore, mvs } = await makeStores();
      await mockRailPartner(db, 'acme', { certify: true });
      await seedPartner(db, 'railx');
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_r2', quote, settlementPartnerId: 'railx' });
      expect(t.settlementPartnerId).toBe('railx');
      expectOneEvent(await eventRows(db), 'tr_pm_r2');
    }
  });
});

function awaiting(o: Partial<Transfer> & { id: string; partnerId: string }): Transfer {
  return {
    phone: PHONE, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919000000322',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment', environment: 'live',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  } as Transfer;
}
const NAMES = { senderName: 'Alex Sender', recipientName: 'Mom' };

async function payRescreen(db: Db, t: Transfer) {
  const owner = await createPartnerStore(db).getPartner(t.partnerId);
  const rules = resolveCorridorRules(owner!, 'US');
  partnerReads.n = 0;
  return rescreenBeforePay(db, t, NAMES, rules);
}

describe('pay-time re-screen (P21 site 2)', { retry: 0 }, () => {
  it('certified owner, possible match -> flagged; one event; poked; the event rolls back with the sanctions.screen row', async () => {
    const { db, store } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    const t = awaiting({ id: 'tr_pay_pm', partnerId: 'acme' });
    await store.saveTransfer(t);
    screenerMode = 'possible';
    const out = await payRescreen(db, t);
    expect(out.kind).toBe('flagged');
    expectOneEvent(await eventRows(db), 'tr_pay_pm');
    expect(pokes.n).toBe(1);
    expect(await screenRows(db, 'tr_pay_pm')).toBe(1);
  });

  it('a failed owner read rolls back the status and the sanctions.screen row (one transaction)', async () => {
    const { db, store } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    const t = awaiting({ id: 'tr_pay_rb', partnerId: 'acme' });
    await store.saveTransfer(t);
    const rules = resolveCorridorRules((await createPartnerStore(db).getPartner('acme'))!, 'US');
    screenerMode = 'possible';
    partnerReads.fail = true;
    await expect(rescreenBeforePay(db, t, NAMES, rules)).rejects.toThrow('partner read failed');
    expect(await screenRows(db, 'tr_pay_rb')).toBe(0);
    expect((await store.getTransfer('tr_pay_rb'))?.complianceStatus).toBe('cleared');
    expect(await eventRows(db)).toEqual([]);
    expect(pokes.n).toBe(0);
  });

  it('a row that moved (applyRescreenIfAwaiting refuses) -> moved, no event, no read', async () => {
    const { db, store } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    const t = awaiting({ id: 'tr_pay_moved', partnerId: 'acme' });
    await store.saveTransfer(t);
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = 'tr_pay_moved'`);
    screenerMode = 'possible';
    expect((await payRescreen(db, t)).kind).toBe('moved');
    expect(partnerReads.n).toBe(0);
    expect(await eventRows(db)).toEqual([]);
    expect(pokes.n).toBe(0);
  });

  it('none for list_unavailable (no read), an uncertified owner, a sandbox row (no read)', async () => {
    {
      const { db, store } = await makeStores();
      await mockRailPartner(db, 'acme', { certify: true });
      const t = awaiting({ id: 'tr_pay_lu', partnerId: 'acme' });
      await store.saveTransfer(t);
      screenerMode = 'unavailable';
      expect((await payRescreen(db, t)).kind).toBe('flagged');
      expect(partnerReads.n).toBe(0);
      expect(await eventRows(db)).toEqual([]);
      expect(pokes.n).toBe(0);
    }
    {
      const { db, store } = await makeStores();
      await mockRailPartner(db, 'beta');
      const t = awaiting({ id: 'tr_pay_un', partnerId: 'beta' });
      await store.saveTransfer(t);
      screenerMode = 'possible';
      expect((await payRescreen(db, t)).kind).toBe('flagged');
      expect(await eventRows(db)).toEqual([]);
      expect(pokes.n).toBe(0);
    }
    {
      const { db, store } = await makeStores();
      await mockRailPartner(db, 'acme', { certify: true });
      const t = awaiting({ id: 'tr_pay_test', partnerId: 'acme', environment: 'test' });
      await store.saveTransfer(t);
      screenerMode = 'possible';
      expect((await payRescreen(db, t)).kind).toBe('flagged');
      expect(partnerReads.n).toBe(0);
      expect(await eventRows(db)).toEqual([]);
      expect(pokes.n).toBe(0);
    }
  });

  it('dedupe: a mint possible match and then a pay-time possible match on the same transfer -> ONE row', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    screenerMode = 'possible';
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_dup' });
    expect((await payRescreen(db, t)).kind).toBe('flagged');
    expectOneEvent(await eventRows(db), 'tr_pm_dup');
  });
});

describe('list sweep (P21 site 3)', { retry: 0 }, () => {
  async function listWait(db: Db, partnerId: string, certify: boolean) {
    await seedPartner(db, partnerId);
    await seedRealMoneyRail(db, partnerId);
    if (certify) await certifyPartnerForTest(db, partnerId);
    const t = await heldRowFor(db, partnerId, 'list_wait');
    const railIntegrations = await createIntegrationsRepo(db).getIntegrations(partnerId);
    return { t, railIntegrations };
  }

  it('possible match with LIST_UNAVAILABLE on the row -> still_held, one event, no poke', async () => {
    const db = await freshDb();
    const { t, railIntegrations } = await listWait(db, 'acme', true);
    const r = await releaseRescreenedHold(db, t.id, { result: possibleResult(), railIntegrations, senderHold: false, realMoney: true, uncovered: [] });
    expect(r).toEqual({ kind: 'still_held' });
    expectOneEvent(await eventRows(db), t.id);
    expect(pokes.n).toBe(0);
  });

  it("clear with another reason left -> still_held, no event; an uncertified owner's possible match -> none", async () => {
    {
      const db = await freshDb();
      const { t, railIntegrations } = await listWait(db, 'acme', true);
      const result: ComplianceResult = { status: 'flagged', reasons: [LARGE_AMOUNT_REASON], evidence: evidence('clear') };
      const r = await releaseRescreenedHold(db, t.id, { result, railIntegrations, senderHold: false, realMoney: true, uncovered: [] });
      expect(r).toEqual({ kind: 'still_held' });
      expect(await eventRows(db)).toEqual([]);
    }
    {
      const db = await freshDb();
      const { t, railIntegrations } = await listWait(db, 'beta', false);
      expect((await createPartnerRepo(db).getPartner('beta'))?.id).toBe('beta');
      const r = await releaseRescreenedHold(db, t.id, { result: possibleResult(), railIntegrations, senderHold: false, realMoney: true, uncovered: [] });
      expect(r).toEqual({ kind: 'still_held' });
      expect((await db.execute(sql`SELECT compliance_reasons FROM transfers WHERE id = ${t.id}`)).rows[0]).toEqual({ compliance_reasons: [POSSIBLE_MATCH_REASON] });
      expect(await eventRows(db)).toEqual([]);
    }
  });
});

describe('staff release re-screen (P21 site 4)', { retry: 0 }, () => {
  async function kycHold(db: Db, partnerId: string, certify: boolean) {
    await seedPartner(db, partnerId);
    await seedRealMoneyRail(db, partnerId);
    if (certify) await certifyPartnerForTest(db, partnerId);
    const t = await heldRowFor(db, partnerId, 'kyc');
    const railIntegrations = await createIntegrationsRepo(db).getIntegrations(partnerId);
    return { t, railIntegrations };
  }

  it('the review path of a certified owner: held, one event', async () => {
    const db = await freshDb();
    const { t, railIntegrations } = await kycHold(db, 'acme', true);
    const review = await platformReviewFor(db, t.id, REL);
    const rr = await releaseHoldAfterRescreen(db, t.id, { result: possibleResult(), uncovered: [], railIntegrations, audit: REL, review });
    expect(rr).toEqual({ kind: 'held', cause: 'review' });
    expectOneEvent(await eventRows(db), t.id);
  });

  it('the no-review path of an uncertified owner: held, no event', async () => {
    const db = await freshDb();
    const { t, railIntegrations } = await kycHold(db, 'beta', false);
    const rr = await releaseHoldAfterRescreen(db, t.id, { result: possibleResult(), uncovered: [], railIntegrations, audit: REL });
    expect(rr).toEqual({ kind: 'held', cause: 'review' });
    expect(await eventRows(db)).toEqual([]);
  });

  it('releaseTransfer: a stale screen re-screened to a possible match -> refused, held, one event, and the caller pokes', async () => {
    const db = await freshDb();
    const store = createStore(fakeRedis(), db);
    const { t } = await kycHold(db, 'acme', true);
    // The newest evidence is 40 h old, so the release re-screens on file first.
    // (audit_events is append-only: a newer row carrying a 40 h old screen time.)
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: 'acme', recipientName: t.recipientName, senderName: 'Test Sender Placeholder', alsoRecipientNames: ['Test Recipient Legal'] },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() + 1000) },
    );
    const review = await platformReviewFor(db, t.id, REL);
    screenerMode = 'possible';
    await expect(releaseTransfer(store, db, t.id, REL, undefined, review)).rejects.toThrow();
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toContain(POSSIBLE_MATCH_REASON);
    expectOneEvent(await eventRows(db), t.id);
    expect(pokes.n).toBe(1);
  });
});

const HYGIENE_FORBIDDEN = [PHONE, '919000000322', 'Mom', 'Alex Sender', '200', '17000', '0.9', 'test:1', 'test-list', 'mom@upi'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids drawn from randomUUID: checked by FORMAT only (O10); a UUID cannot carry a name, phone, amount, score or list id. */
const RANDOM_ID_KEYS = new Set(['eventId', 'reviewId']);

/**
 * Every key passes the key-name regex. A random id key must be a UUID; every
 * other string or number misses every forbidden fixture value.
 */
function hygieneWalk(v: unknown, path: string): void {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      expect(k, path).not.toMatch(/name|phone|amount|score|entry|list|hash|reason|payout/i);
      if (RANDOM_ID_KEYS.has(k)) {
        expect(x, `${path}.${k}`).toMatch(UUID_RE);
        continue;
      }
      hygieneWalk(x, `${path}.${k}`);
    }
  } else if (typeof v === 'string' || typeof v === 'number') {
    for (const f of HYGIENE_FORBIDDEN) expect(String(v), path).not.toContain(f);
  }
}

describe('payload hygiene', { retry: 0 }, () => {
  it('no enqueued payload carries a name, phone, amount, score or list id', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    screenerMode = 'possible';
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_scan' });
    const rows = await eventRows(db);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      hygieneWalk(r.payload, 'payload');
      expect(r.payload.transferId).toBe(t.id);
    }
  });

  it('a random eventId that happens to contain a forbidden digit run (200) still passes the walk (F5)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await mockRailPartner(db, 'acme', { certify: true });
    screenerMode = 'possible';
    let n = 0;
    // Every id the code draws in this test contains '200'; each is still unique.
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockImplementation(() => `20000000-0000-4000-8000-${String(++n).padStart(9, '0')}200` as `${string}-${string}-${string}-${string}-${string}`);
    try {
      const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', id: 'tr_pm_scan_id' });
      const rows = await eventRows(db);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(String(r.payload.eventId)).toContain('200');
        hygieneWalk(r.payload, 'payload');
        expect(r.payload.transferId).toBe(t.id);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
