import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo, type PartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { sweepStaleRates } from '@/lib/rate-staleness';
import type { Db } from '@/db/client';

// sweepStaleRates — the pricing safety net (runs on every /api/worker poke +
// 5-min heartbeat). One expired pushed rate ⇒ exactly ONE deduped ops alert,
// forever; a re-push that expires again (new expiresAt epoch ⇒ new dedupe key)
// alerts again. Relative dates only.

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

let db: Db;
let repo: PartnerRateRepo;

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  repo = createPartnerRateRepo(db);
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
});

describe('sweepStaleRates', () => {
  it('an expired pushed rate enqueues ONE ops.alert keyed on the expiresAt epoch', async () => {
    const expiresAt = inHours(-1);
    await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt, pushedAt: inHours(-2),
    });

    const alerted = await sweepStaleRates(db, new Date());
    expect(alerted).toBe(1);
    expect(await outboxRows()).toEqual([
      { kind: 'ops.alert', dedupe_key: `stale-rate:p1:USDINR:${Date.parse(expiresAt)}` },
    ]);
  });

  it('re-running the sweep adds NOTHING (dedupe holds forever)', async () => {
    await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: inHours(-1), pushedAt: inHours(-2),
    });

    expect(await sweepStaleRates(db, new Date())).toBe(1);
    expect(await sweepStaleRates(db, new Date())).toBe(0);
    expect(await sweepStaleRates(db, new Date())).toBe(0);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('fresh pushed rates and margin-only rates raise no alerts', async () => {
    await repo.upsertRate({
      id: 'pr_fresh', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: inHours(2), pushedAt: inHours(0),
    });
    await repo.upsertRate({
      id: 'pr_margin', partnerId: 'p2', sourceCurrency: 'GBP', destinationCurrency: 'INR',
      marginBps: 25, // never pushed — nothing to go stale
    });

    expect(await sweepStaleRates(db, new Date())).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a re-pushed-then-expired rate alerts AGAIN (new expiresAt ⇒ new dedupe key)', async () => {
    const firstExpiry = inHours(-3);
    await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: firstExpiry, pushedAt: inHours(-4),
    });
    expect(await sweepStaleRates(db, new Date())).toBe(1);

    // The partner re-pushes (fresh again) — no new alert while fresh.
    const secondExpiry = inHours(1);
    await repo.upsertRate({
      id: 'pr_2', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 87, expiresAt: secondExpiry, pushedAt: inHours(0),
    });
    expect(await sweepStaleRates(db, new Date())).toBe(0);

    // ...then that push lapses too: a NEW alert with the NEW epoch in the key.
    expect(await sweepStaleRates(db, new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    expect(await outboxRows()).toEqual([
      { kind: 'ops.alert', dedupe_key: `stale-rate:p1:USDINR:${Date.parse(firstExpiry)}` },
      { kind: 'ops.alert', dedupe_key: `stale-rate:p1:USDINR:${Date.parse(secondExpiry)}` },
    ]);
  });

  it('alerts one row per expired corridor across partners', async () => {
    const e1 = inHours(-1);
    const e2 = inHours(-2);
    await repo.upsertRate({
      id: 'pr_1', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: e1, pushedAt: inHours(-2),
    });
    await repo.upsertRate({
      id: 'pr_2', partnerId: 'p2', sourceCurrency: 'GBP', destinationCurrency: 'AED',
      effectiveRate: 4.6, expiresAt: e2, pushedAt: inHours(-3),
    });

    expect(await sweepStaleRates(db, new Date())).toBe(2);
    const keys = (await outboxRows()).map((r) => r.dedupe_key).sort();
    expect(keys).toEqual(
      [
        `stale-rate:p1:USDINR:${Date.parse(e1)}`,
        `stale-rate:p2:GBPAED:${Date.parse(e2)}`,
      ].sort(),
    );
  });
});
