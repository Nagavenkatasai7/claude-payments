import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo, type PartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { sweepStaleRates, sweepFxHealth, FX_PROBE_CURRENCIES } from '@/lib/rate-staleness';
import { RateUnavailableError, type FxRates } from '@/lib/rate';
import type { FxRatesFn } from '@/lib/corridor-demand';
import type { Db } from '@/db/client';
import type { CurrencyCode } from '@/lib/types';

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

describe('sweepFxHealth (Task 9) — the FX outage alert', () => {
  const live = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });
  const fxWith = (bad: Partial<Record<CurrencyCode, 'cache' | 'down'>>): FxRatesFn => async (c) => {
    if (bad[c] === 'down') throw new RateUnavailableError('fetch_failed', c);
    if (bad[c] === 'cache') return { ...live(), fetchedAt: Date.now() - 600_000, source: 'cache' };
    return live();
  };

  it('probes every fetched currency — never AED (derived from the USD peg)', () => {
    expect([...FX_PROBE_CURRENCIES].sort()).toEqual(['AUD', 'CAD', 'GBP', 'HKD', 'INR', 'MXN', 'NZD', 'SGD', 'USD']);
  });

  it('a refusing and a degraded currency each raise ONE ops.alert keyed on the hour bucket', async () => {
    const now = new Date();
    const bucket = Math.floor(now.getTime() / 3_600_000);
    expect(await sweepFxHealth(db, fxWith({ GBP: 'down', USD: 'cache' }), now)).toBe(2);
    const rows = await outboxRows();
    expect(rows.every((r) => r.kind === 'ops.alert')).toBe(true);
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual([`fx-health:GBP:${bucket}`, `fx-health:USD:${bucket}`]);
  });

  it('re-running in the same hour adds NOTHING; the next hour alerts again', async () => {
    const now = new Date();
    const fx = fxWith({ GBP: 'down' });
    expect(await sweepFxHealth(db, fx, now)).toBe(1);
    expect(await sweepFxHealth(db, fx, now)).toBe(0);
    expect(await sweepFxHealth(db, fx, new Date(now.getTime() + 3_600_000))).toBe(1);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('all-live rates raise no alert', async () => {
    expect(await sweepFxHealth(db, fxWith({}), new Date())).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('the alert names the currency and state only — no phone, amount or partner data', async () => {
    await sweepFxHealth(db, fxWith({ MXN: 'down' }), new Date());
    const r = await db.execute(sql`SELECT payload FROM outbox`);
    const { message } = (r as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0].payload;
    expect(message).toContain('MXN');
    expect(message).toContain('UNAVAILABLE (fetch_failed)');
    expect(message).not.toMatch(/\d{7,}/);
  });
});
