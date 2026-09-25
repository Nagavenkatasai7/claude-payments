import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo, type PartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { sweepStaleRates, sweepFxHealth, FX_PROBE_CURRENCIES } from '@/lib/rate-staleness';
import { RateUnavailableError, resetRateCacheForTests, type FxRates } from '@/lib/rate';
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

describe('sweepFxHealth (Task 9 + R9) — the FX outage alert', () => {
  const MIN = 60_000;
  const live = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });
  type Bad = 'cache' | 'young-cache' | 'undated-cache' | 'down';
  const fxWith = (bad: Partial<Record<CurrencyCode, Bad>>): FxRatesFn => async (c) => {
    if (bad[c] === 'down') throw new RateUnavailableError('fetch_failed', c);
    if (bad[c] === 'cache') return { ...live(), fetchedAt: Date.now() - 16 * MIN, source: 'cache' };
    if (bad[c] === 'young-cache') return { ...live(), fetchedAt: Date.now() - 10 * MIN, source: 'cache' };
    if (bad[c] === 'undated-cache') return { toInr: 95.82, toUsd: 1, source: 'cache' };
    return live();
  };
  const NO_STAGGER = { staggerMs: 0 };
  const messages = async (): Promise<string[]> => {
    const r = await db.execute(sql`SELECT payload FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ payload: { message: string } }> }).rows.map((x) => x.payload.message);
  };

  beforeEach(() => {
    resetRateCacheForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetRateCacheForTests();
  });

  it('probes every fetched currency — never AED (derived from the USD peg)', () => {
    expect([...FX_PROBE_CURRENCIES].sort()).toEqual(['AUD', 'CAD', 'GBP', 'HKD', 'INR', 'MXN', 'NZD', 'SGD', 'USD']);
  });

  it('refusing and degraded (>= 15 min) currencies raise ONE alert per severity, keyed on severity + hour bucket', async () => {
    const now = new Date();
    const bucket = Math.floor(now.getTime() / 3_600_000);
    const fx = fxWith({ GBP: 'down', MXN: 'down', USD: 'cache', CAD: 'cache' });
    expect(await sweepFxHealth(db, fx, now, NO_STAGGER)).toBe(2);
    const rows = await outboxRows();
    expect(rows.every((r) => r.kind === 'ops.alert')).toBe(true);
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
      [`fx-health:DEGRADED:${bucket}`, `fx-health:UNAVAILABLE:${bucket}`].sort(),
    );
    const [a, b] = await messages();
    const unavailable = [a, b].find((m) => m.includes('UNAVAILABLE'))!;
    const degraded = [a, b].find((m) => m.includes('DEGRADED'))!;
    expect(unavailable).toContain('GBP (fetch_failed)');
    expect(unavailable).toContain('MXN (fetch_failed)');
    expect(degraded).toContain('USD');
    expect(degraded).toContain('CAD');
  });

  it('a served cache younger than 15 min raises NO alert (the quote path is still pricing)', async () => {
    expect(await sweepFxHealth(db, fxWith({ USD: 'young-cache', GBP: 'young-cache' }), new Date(), NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a cache result with no fetchedAt (age unknowable) alerts rather than hiding', async () => {
    expect(await sweepFxHealth(db, fxWith({ HKD: 'undated-cache' }), new Date(), NO_STAGGER)).toBe(1);
    expect((await messages())[0]).toContain('HKD');
  });

  it('UNAVAILABLE still alerts immediately (no age gate)', async () => {
    const now = new Date();
    expect(await sweepFxHealth(db, fxWith({ INR: 'down' }), now, NO_STAGGER)).toBe(1);
    expect((await outboxRows())[0].dedupe_key).toBe(`fx-health:UNAVAILABLE:${Math.floor(now.getTime() / 3_600_000)}`);
  });

  it('re-running in the same hour adds NOTHING; the next hour alerts again', async () => {
    const now = new Date();
    const fx = fxWith({ GBP: 'down' });
    expect(await sweepFxHealth(db, fx, now, NO_STAGGER)).toBe(1);
    expect(await sweepFxHealth(db, fxWith({ GBP: 'down', AUD: 'down' }), now, NO_STAGGER)).toBe(0);
    expect(await sweepFxHealth(db, fx, new Date(now.getTime() + 3_600_000), NO_STAGGER)).toBe(1);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('DEGRADED then UNAVAILABLE in the same hour BOTH alert (severity is in the dedupe key)', async () => {
    const now = new Date();
    expect(await sweepFxHealth(db, fxWith({ USD: 'cache' }), now, NO_STAGGER)).toBe(1);
    expect(await sweepFxHealth(db, fxWith({ USD: 'down' }), new Date(now.getTime() + 10 * MIN), NO_STAGGER)).toBe(1);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('all-live rates raise no alert', async () => {
    expect(await sweepFxHealth(db, fxWith({}), new Date(), NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('the alert names currencies and state only — no phone, amount or partner data', async () => {
    await sweepFxHealth(db, fxWith({ MXN: 'down' }), new Date(), NO_STAGGER);
    const [message] = await messages();
    expect(message).toContain('MXN');
    expect(message).toContain('UNAVAILABLE');
    expect(message).toContain('fetch_failed');
    expect(message).not.toMatch(/\d{7,}/);
  });

  it('staggers probe starts instead of firing every currency in the same instant', async () => {
    vi.useFakeTimers();
    const fx = vi.fn(fxWith({}));
    const done = sweepFxHealth(db, fx, new Date(), { staggerMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fx).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fx).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250 * FX_PROBE_CURRENCIES.length);
    expect(fx).toHaveBeenCalledTimes(FX_PROBE_CURRENCIES.length);
    vi.useRealTimers();
    expect(await done).toBe(0);
  });

  // ── The DEFAULT probe (what the worker actually runs): real getFxRates,
  //    stubbed Frankfurter. The Redis L2 is VITEST-skipped.
  const timeoutError = (): Error => Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });
  const frankfurterOk = (url: string) => {
    const from = new URL(url).searchParams.get('from');
    return { ok: true, json: async () => ({ date: '2026-09-21', rates: { INR: from === 'INR' ? undefined : 90, USD: 1.1 } }) };
  };

  it('default probe: a single slow Frankfurter response is retried and sends NO alert', async () => {
    let slowUsd = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (slowUsd && url.includes('from=USD')) { slowUsd = false; throw timeoutError(); }
      return frankfurterOk(url);
    }));
    expect(await sweepFxHealth(db, undefined, new Date(), NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
    // USD was dialed twice (one retry), everything else once.
    expect(vi.mocked(global.fetch).mock.calls.filter(([u]) => String(u).includes('from=USD'))).toHaveLength(2);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(FX_PROBE_CURRENCIES.length + 1);
  });

  it('default probe: an outage served from a 6-min-old cache sends NO alert', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterOk(url)));
    expect(await sweepFxHealth(db, undefined, new Date(), NO_STAGGER)).toBe(0);
    vi.advanceTimersByTime(6 * MIN);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()));
    expect(await sweepFxHealth(db, undefined, new Date(), NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('default probe: a served cache >= 15 min old sends exactly ONE combined alert listing the currencies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterOk(url)));
    expect(await sweepFxHealth(db, undefined, new Date(), NO_STAGGER)).toBe(0);
    vi.advanceTimersByTime(16 * MIN);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()));
    const now = new Date();
    expect(await sweepFxHealth(db, undefined, now, NO_STAGGER)).toBe(1);
    // Two attempts per currency (the retry) before it counts as failed.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2 * FX_PROBE_CURRENCIES.length);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`fx-health:DEGRADED:${Math.floor(now.getTime() / 3_600_000)}`);
    const [message] = await messages();
    for (const c of FX_PROBE_CURRENCIES) expect(message).toContain(c);
    expect(message).toContain('16 min');
    expect(message).not.toMatch(/\d{7,}/);
  });

  it('default probe: nothing cached and Frankfurter down ⇒ ONE combined UNAVAILABLE alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()));
    const now = new Date();
    expect(await sweepFxHealth(db, undefined, now, NO_STAGGER)).toBe(1);
    const rows = await outboxRows();
    expect(rows.map((r) => r.dedupe_key)).toEqual([`fx-health:UNAVAILABLE:${Math.floor(now.getTime() / 3_600_000)}`]);
    expect((await messages())[0]).toContain('USD (timeout)');
  });
});
