import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedTwoTenants } from './helpers-partner-app';
import { fakeRedis } from './helpers';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { createCustomerRepo, readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { loadSenderScreening } from '@/lib/sender-screening';
import { senderScreeningHoldActive, SENDER_SCREENING_REASON } from '@/lib/compliance-config';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Db } from '@/db/client';

// M3-10 follow-up: the SENDER customer's PEP / watchlist flags for the partner hold release. A
// narrow, tenant-scoped read (no PII column, no decrypt); the lib wrapper fails CLOSED to null.
const PHONE = '14155550101';
const NO_TIMES = { screeningFlaggedAt: null, screeningClearedAt: null };
let db: Db;

const seedCustomer = async (partnerId: string, phone: string, flags: { pep?: boolean | null; watch?: boolean | null } = {}) => {
  await createCustomerRepo(db, async () => null).ensureCustomer(partnerId, phone);
  await db.execute(
    sql`UPDATE customers SET pep_hit = ${flags.pep ?? null}, watchlist_hit = ${flags.watch ?? null} WHERE partner_id = ${partnerId} AND phone = ${phone}`,
  );
};

beforeEach(async () => {
  db = await freshDb();
  await seedTwoTenants(db);
});

describe('readSenderScreeningFlags (customer-repo)', () => {
  it('returns the two flags of the tenant’s own row', async () => {
    await seedCustomer('pa', PHONE, { pep: true, watch: false });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: true, watchlistHit: false, ...NO_TIMES });
  });

  it('an unflagged row reads as nulls', async () => {
    await seedCustomer('pa', PHONE);
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: null, ...NO_TIMES });
  });

  it('is TENANT-SCOPED: another tenant’s row for the same phone is never read', async () => {
    await seedCustomer('pb', PHONE, { pep: true, watch: true });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toBeNull();
    await seedCustomer('pa', PHONE);
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: null, ...NO_TIMES });
  });

  it('a missing row → null', async () => {
    expect(await readSenderScreeningFlags(db, 'pa', '19995550000')).toBeNull();
  });
});

describe('loadSenderScreening (fail-closed wrapper)', () => {
  it('passes a found row through', async () => {
    await seedCustomer('pa', PHONE, { watch: true });
    expect(await loadSenderScreening(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: true, ...NO_TIMES });
  });

  it('a lookup failure → null (never throws), so the release predicate refuses; the log never carries the phone', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture));
    try {
      // A failed query's message carries its bound params: the phone and any other value.
      const broken = { select: vi.fn(() => { throw new Error('params: 14155550101, bound-param-sentinel'); }) } as unknown as Db;
      await expect(loadSenderScreening(broken, 'pa', PHONE)).resolves.toBeNull();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain('5550101');
      expect(l).not.toContain('bound-param-sentinel');
    }
  });

  it('a blank tenant or phone → null without a query', async () => {
    const spy = { select: vi.fn() } as unknown as Db;
    expect(await loadSenderScreening(spy, '', PHONE)).toBeNull();
    expect(await loadSenderScreening(spy, 'pa', '')).toBeNull();
    expect((spy as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});

// ── Fix pack 2 T6 (R06): the sender screening hold's two times ──────────────
describe('sender screening hold times (fix pack 2 R06)', () => {
  const ORIGINAL_LIST = process.env.SANCTIONS_LIST;
  afterEach(() => {
    restoreOfacSource(ORIGINAL_LIST);
    vi.unstubAllGlobals();
  });
  const repo = () => createCustomerRepo(db, async () => null);
  const HOUR = 3_600_000;

  it('reads both times', async () => {
    await seedCustomer('pa', PHONE, { watch: true });
    const flagged = new Date(Date.now() - 2 * HOUR);
    const cleared = new Date(Date.now() - HOUR);
    expect(await repo().stampScreeningFlagged('pa', PHONE, flagged)).toBe(true);
    const r = await repo().clearScreeningHold('pa', PHONE, cleared);
    expect(r).toEqual({ found: true, previous: { pepHit: null, watchlistHit: true, screeningFlaggedAt: flagged, screeningClearedAt: null } });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({
      pepHit: null, watchlistHit: true, screeningFlaggedAt: flagged, screeningClearedAt: cleared,
    });
    const c = await repo().getCustomer('pa', PHONE);
    expect(c?.screeningFlaggedAt).toBe(flagged.toISOString());
    expect(c?.screeningClearedAt).toBe(cleared.toISOString());
  });

  it('writers are tenant-scoped', async () => {
    await seedCustomer('pa', PHONE, { watch: true });
    await seedCustomer('pb', PHONE, { watch: true });
    const at = new Date(Date.now() - HOUR);
    await repo().stampScreeningFlagged('pa', PHONE, at);
    await repo().clearScreeningHold('pa', PHONE, new Date());
    expect(await readSenderScreeningFlags(db, 'pb', PHONE)).toEqual({ pepHit: null, watchlistHit: true, ...NO_TIMES });
    // A tenant without the row: nothing written, nothing found.
    expect(await repo().stampScreeningFlagged('pb', '19995550000', at)).toBe(false);
    expect(await repo().clearScreeningHold('pb', '19995550000', at)).toEqual({ found: false, previous: null });
  });

  it('saveCustomer never rewrites them', async () => {
    await seedCustomer('pa', PHONE, { pep: true });
    const stale = (await repo().getCustomer('pa', PHONE))!; // read BEFORE the stamp and the clear
    const flagged = new Date(Date.now() - 2 * HOUR);
    const cleared = new Date(Date.now() - HOUR);
    await repo().stampScreeningFlagged('pa', PHONE, flagged);
    await repo().clearScreeningHold('pa', PHONE, cleared);
    await repo().saveCustomer({ ...stale, updatedAt: new Date().toISOString() });
    const after = await readSenderScreeningFlags(db, 'pa', PHONE);
    expect(after?.screeningFlaggedAt).toEqual(flagged);
    expect(after?.screeningClearedAt).toEqual(cleared);
    // And a copy that carries other times is ignored too.
    await repo().saveCustomer({ ...stale, screeningFlaggedAt: undefined, screeningClearedAt: new Date().toISOString() });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: true, watchlistHit: null, screeningFlaggedAt: flagged, screeningClearedAt: cleared });
  });

  it('a stale saveCustomer nulls watchlist_hit after the stamp -> hold still active; an http mint still holds', async () => {
    delete process.env.SANCTIONS_LIST;
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
    await seedCustomer('pa', PHONE);
    await db.execute(sql`UPDATE customers SET kyc_status = 'verified', first_seen_at = now() - interval '10 days' WHERE partner_id = 'pa' AND phone = ${PHONE}`);
    const stale = (await repo().getCustomer('pa', PHONE))!; // read before the Persona match landed
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'pa' AND phone = ${PHONE}`);
    await repo().stampScreeningFlagged('pa', PHONE, new Date(Date.now() - HOUR));
    await repo().saveCustomer({ ...stale, updatedAt: new Date().toISOString() });
    const flags = await readSenderScreeningFlags(db, 'pa', PHONE);
    expect(flags?.watchlistHit).toBeNull(); // the stale upsert nulled the boolean
    expect(senderScreeningHoldActive(flags)).toBe(true); // the stamp keeps the hold

    await setRailProviderType(db, 'pa', 'http');
    primeOfacSource({ checkedAgoMs: HOUR });
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const t = await createTransfer(store, createPartnerStore(db), createMonthlyVolumeStore(createStore(redis, db)), {
      partnerId: 'pa', phone: PHONE, amountSource: 200, sourceCurrency: 'USD', recipientName: 'Mom',
      recipientPhone: '919000000077', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', senderKycStatus: 'verified',
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
  });
});
