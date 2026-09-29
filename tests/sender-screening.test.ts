import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedTwoTenants } from './helpers-partner-app';
import { createCustomerRepo, readSenderScreeningFlags, readSenderScreeningFlagsForPhones } from '@/db/repos/customer-repo';
import { loadSenderScreening, loadSenderScreeningMap } from '@/lib/sender-screening';
import type { Db } from '@/db/client';

// M3-10 follow-up: the SENDER customer's PEP / watchlist flags for the partner hold release. A
// narrow, tenant-scoped read (no PII column, no decrypt); the lib wrapper fails CLOSED to null.
const PHONE = '14155550101';
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
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: true, watchlistHit: false });
  });

  it('an unflagged row reads as nulls', async () => {
    await seedCustomer('pa', PHONE);
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: null });
  });

  it('is TENANT-SCOPED: another tenant’s row for the same phone is never read', async () => {
    await seedCustomer('pb', PHONE, { pep: true, watch: true });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toBeNull();
    await seedCustomer('pa', PHONE);
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: null });
  });

  it('a missing row → null', async () => {
    expect(await readSenderScreeningFlags(db, 'pa', '19995550000')).toBeNull();
  });
});

describe('loadSenderScreening (fail-closed wrapper)', () => {
  it('passes a found row through', async () => {
    await seedCustomer('pa', PHONE, { watch: true });
    expect(await loadSenderScreening(db, 'pa', PHONE)).toEqual({ pepHit: null, watchlistHit: true });
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

// M3-10 Task 10.3: the legacy compliance page's Release button for PARTNER-scoped staff needs the
// flags of every held row's sender, read in ONE tenant-scoped query.
describe('readSenderScreeningFlagsForPhones + loadSenderScreeningMap (batch, Task 10.3)', () => {
  const P2 = '14155550202';

  it('returns a phone → flags map for this tenant’s rows only', async () => {
    await seedCustomer('pa', PHONE, { pep: true });
    await seedCustomer('pa', P2);
    await seedCustomer('pb', P2, { watch: true });
    const m = await readSenderScreeningFlagsForPhones(db, 'pa', [PHONE, P2, '19995550000']);
    expect(m.get(PHONE)).toEqual({ pepHit: true, watchlistHit: null });
    expect(m.get(P2)).toEqual({ pepHit: null, watchlistHit: null });
    expect(m.has('19995550000')).toBe(false);
    expect(m.size).toBe(2);
  });

  it('an empty phone list → an empty map without a query', async () => {
    const spy = { select: vi.fn() } as unknown as Db;
    expect((await readSenderScreeningFlagsForPhones(spy, 'pa', [])).size).toBe(0);
    expect((spy as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it('the wrapper de-duplicates, drops blanks and fails CLOSED to an empty map', async () => {
    await seedCustomer('pa', PHONE);
    const m = await loadSenderScreeningMap(db, 'pa', [PHONE, PHONE, '']);
    expect([...m.keys()]).toEqual([PHONE]);
    const broken = { select: vi.fn(() => { throw new Error('connection reset'); }) } as unknown as Db;
    expect((await loadSenderScreeningMap(broken, 'pa', [PHONE])).size).toBe(0);
    expect((await loadSenderScreeningMap(db, '', [PHONE])).size).toBe(0);
  });
});
