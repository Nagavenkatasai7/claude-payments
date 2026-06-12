import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo, type PartnerRateRepo } from '@/db/repos/partner-rate-repo';
import type { Db } from '@/db/client';

let db: Db;
let repo: PartnerRateRepo;

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(async () => {
  db = await freshDb();
  repo = createPartnerRateRepo(db);
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
});

describe('partner-rate-repo', () => {
  it('upserts a pushed rate and reads it back', async () => {
    const saved = await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86.123456, expiresAt: inHours(1), pushedAt: new Date().toISOString(),
    });
    expect(saved.effectiveRate).toBeCloseTo(86.123456, 6);
    const read = await repo.getRate('p1', 'USD', 'INR');
    expect(read?.effectiveRate).toBeCloseTo(86.123456, 6);
    expect(read?.marginBps).toBeUndefined();
  });

  it('merge semantics: a margin save does not clobber a pushed rate, and vice versa', async () => {
    await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: inHours(2), pushedAt: new Date().toISOString(),
    });
    // Admin sets a margin — pushed fields untouched (undefined ⇒ keep).
    await repo.upsertRate({
      id: 'pr_x', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      marginBps: 25,
    });
    let r = await repo.getRate('p1', 'USD', 'INR');
    expect(r?.effectiveRate).toBe(86);
    expect(r?.marginBps).toBe(25);
    // A new push leaves the margin in place.
    await repo.upsertRate({
      id: 'pr_y', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 87, expiresAt: inHours(3), pushedAt: new Date().toISOString(),
    });
    r = await repo.getRate('p1', 'USD', 'INR');
    expect(r?.effectiveRate).toBe(87);
    expect(r?.marginBps).toBe(25);
    // Explicit null CLEARS the margin.
    await repo.upsertRate({
      id: 'pr_z', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      marginBps: null,
    });
    r = await repo.getRate('p1', 'USD', 'INR');
    expect(r?.marginBps).toBeUndefined();
    expect(r?.effectiveRate).toBe(87);
  });

  it('one row per (partner, corridor): the upsert never duplicates', async () => {
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 10 });
    await repo.upsertRate({ id: 'b', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 20 });
    const all = await repo.listRatesForPartner('p1');
    expect(all).toHaveLength(1);
    expect(all[0].marginBps).toBe(20);
  });

  it('listCandidatesForCorridor joins ACTIVE partners only and filters by corridor', async () => {
    await db.execute(sql.raw(
      `INSERT INTO partners (id, name, status, countries, kyc_mode)
       VALUES ('suspended_p', 'Suspended P', 'suspended', '["US"]'::jsonb, 'ours')`,
    ));
    await repo.upsertRate({ id: 'r1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 10 });
    await repo.upsertRate({ id: 'r2', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'r3', partnerId: 'suspended_p', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 99 });
    await repo.upsertRate({ id: 'r4', partnerId: 'p1', sourceCurrency: 'GBP', destinationCurrency: 'INR', marginBps: 10 });
    const usdInr = await repo.listCandidatesForCorridor('USD', 'INR');
    expect(usdInr.map((r) => r.partnerId).sort()).toEqual(['p1', 'p2']);
  });

  it('listExpired returns only pushed rates past their TTL', async () => {
    await repo.upsertRate({ id: 'e1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(-1) });
    await repo.upsertRate({ id: 'e2', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    // margin-only rows have no TTL to expire
    await repo.upsertRate({ id: 'e3', partnerId: 'p1', sourceCurrency: 'GBP', destinationCurrency: 'INR', marginBps: 10 });
    const expired = await repo.listExpired(new Date());
    expect(expired).toHaveLength(1);
    expect(expired[0].partnerId).toBe('p1');
    expect(expired[0].sourceCurrency).toBe('USD');
  });

  it('listAllRates returns every row (platform dashboard)', async () => {
    await repo.upsertRate({ id: 'x1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 5 });
    await repo.upsertRate({ id: 'x2', partnerId: 'p2', sourceCurrency: 'GBP', destinationCurrency: 'INR', marginBps: 5 });
    expect(await repo.listAllRates()).toHaveLength(2);
  });
});
