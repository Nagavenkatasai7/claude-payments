import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedTwoTenants } from './helpers-partner-app';
import { createCustomerRepo, readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { loadSenderScreening } from '@/lib/sender-screening';
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

  it('a lookup failure → null (never throws), so the release predicate refuses', async () => {
    const broken = { select: vi.fn(() => { throw new Error('connection reset 14155550101'); }) } as unknown as Db;
    await expect(loadSenderScreening(broken, 'pa', PHONE)).resolves.toBeNull();
  });

  it('a blank tenant or phone → null without a query', async () => {
    const spy = { select: vi.fn() } as unknown as Db;
    expect(await loadSenderScreening(spy, '', PHONE)).toBeNull();
    expect(await loadSenderScreening(spy, 'pa', '')).toBeNull();
    expect((spy as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});
