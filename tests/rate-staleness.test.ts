import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo, type PartnerRateRepo } from '@/db/repos/partner-rate-repo';
import {
  sweepStaleRates, sweepFxHealth, recheckFailedFx, FX_PROBE_CURRENCIES, FX_RECHECK_KEY, type FxRecheckRedis,
} from '@/lib/rate-staleness';
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
    if (bad[c] === 'cache') return { ...live(), fetchedAt: Date.now() - 46 * MIN, source: 'cache' };
    // Oct 6 alerts: one missed 30-min probe serves a ~30-min-old rate.
    if (bad[c] === 'young-cache') return { ...live(), fetchedAt: Date.now() - 30 * MIN, source: 'cache' };
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

  it('refusing and degraded (>= 45 min) currencies raise ONE alert per severity, keyed on severity + hour bucket', async () => {
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

  it('a served cache younger than 45 min (one missed probe, ~30 min old) raises NO alert', async () => {
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
    // Today's UTC date (relative — never a fixed day): a current fixing, so
    // the Step 0 FIXING alert stays quiet and these cases test fetch health only.
    const date = new Date().toISOString().slice(0, 10);
    return { ok: true, json: async () => ({ date, rates: { INR: from === 'INR' ? undefined : 90, USD: 1.1 } }) };
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

  it('default probe: a served cache >= 45 min old sends exactly ONE combined alert listing the currencies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterOk(url)));
    expect(await sweepFxHealth(db, undefined, new Date(), NO_STAGGER)).toBe(0);
    vi.advanceTimersByTime(46 * MIN);
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
    expect(message).toContain('46 min');
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

// Oct 6 alerts: a failed probe lists the currencies it could not refresh, and
// the per-minute cron re-checks only those (every 5th minute) instead of
// waiting 30 min for the next probe. Nothing listed ⇒ no fetch, no Neon.
describe('FX re-check list (Oct 6 alerts)', () => {
  const MIN = 60_000;
  const live = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });
  const cacheAged = (min: number): FxRates => ({ ...live(), fetchedAt: Date.now() - min * MIN, source: 'cache' });
  const NO_STAGGER = { staggerMs: 0 };
  const fakeRecheck = (initial?: string) => {
    const strings = new Map<string, string>();
    if (initial !== undefined) strings.set(FX_RECHECK_KEY, initial);
    const store = {
      strings,
      failing: false,
      ttl: undefined as number | undefined,
      async get(key: string) {
        if (store.failing) throw new Error('upstash down');
        return strings.get(key) ?? null;
      },
      async set(key: string, value: string, opts?: { ex?: number }) {
        if (store.failing) throw new Error('upstash down');
        strings.set(key, value);
        store.ttl = opts?.ex;
        return 'OK';
      },
    };
    return store satisfies FxRecheckRedis;
  };

  it('a sweep lists every currency it served from cache or refused; all live clears the list', async () => {
    const redis = fakeRecheck();
    const fx: FxRatesFn = async (c) => {
      if (c === 'GBP') return cacheAged(30);
      if (c === 'MXN') throw new RateUnavailableError('timeout', c);
      return live();
    };
    await sweepFxHealth(db, fx, new Date(), { ...NO_STAGGER, recheck: redis });
    expect(redis.strings.get(FX_RECHECK_KEY)).toBe('GBP,MXN');
    expect(redis.ttl).toBeGreaterThanOrEqual(30 * 60);
    await sweepFxHealth(db, async () => live(), new Date(), { ...NO_STAGGER, recheck: redis });
    expect(redis.strings.get(FX_RECHECK_KEY)).toBe('');
  });

  it('nothing listed: no fetch, no database, no write', async () => {
    for (const initial of [undefined, '']) {
      const redis = fakeRecheck(initial);
      const fx = vi.fn<FxRatesFn>(async () => live());
      const getDb = vi.fn(() => db);
      expect(await recheckFailedFx(getDb, redis, fx, new Date(), NO_STAGGER)).toBe(0);
      expect(fx).not.toHaveBeenCalled();
      expect(getDb).not.toHaveBeenCalled();
      expect(redis.ttl).toBeUndefined();
    }
  });

  it('re-probes ONLY the listed currencies; a live answer clears them with no alert', async () => {
    const redis = fakeRecheck('GBP,CAD');
    const fx = vi.fn<FxRatesFn>(async () => live());
    expect(await recheckFailedFx(() => db, redis, fx, new Date(), NO_STAGGER)).toBe(0);
    expect(fx.mock.calls.map(([c]) => c).sort()).toEqual(['CAD', 'GBP']);
    expect(redis.strings.get(FX_RECHECK_KEY)).toBe('');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('still failing under 45 min: stays listed, no alert', async () => {
    const redis = fakeRecheck('GBP');
    expect(await recheckFailedFx(() => db, redis, async () => cacheAged(35), new Date(), NO_STAGGER)).toBe(0);
    expect(redis.strings.get(FX_RECHECK_KEY)).toBe('GBP');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('still failing at >= 45 min: ONE DEGRADED alert with the sweep\'s dedupe key', async () => {
    const now = new Date();
    const redis = fakeRecheck('GBP');
    expect(await recheckFailedFx(() => db, redis, async () => cacheAged(50), now, NO_STAGGER)).toBe(1);
    expect(await recheckFailedFx(() => db, redis, async () => cacheAged(55), now, NO_STAGGER)).toBe(0);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual([
      `fx-health:DEGRADED:${Math.floor(now.getTime() / 3_600_000)}`,
    ]);
    expect(redis.strings.get(FX_RECHECK_KEY)).toBe('GBP');
  });

  it('a refusal alerts UNAVAILABLE at once', async () => {
    const now = new Date();
    const redis = fakeRecheck('GBP');
    const fx: FxRatesFn = async (c) => { throw new RateUnavailableError('timeout', c); };
    expect(await recheckFailedFx(() => db, redis, fx, now, NO_STAGGER)).toBe(1);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual([
      `fx-health:UNAVAILABLE:${Math.floor(now.getTime() / 3_600_000)}`,
    ]);
  });

  it('never dials a code outside the probe table (AED, junk)', async () => {
    const redis = fakeRecheck('XXX,AED,GBP,../x');
    const fx = vi.fn<FxRatesFn>(async () => live());
    await recheckFailedFx(() => db, redis, fx, new Date(), NO_STAGGER);
    expect(fx.mock.calls.map(([c]) => c)).toEqual(['GBP']);
  });

  it('skips the FIXING check (the :17/:47 sweep owns it)', async () => {
    const redis = fakeRecheck('GBP');
    const frozen: FxRatesFn = async () => ({ ...live(), asOf: '2026-01-02' });
    expect(await recheckFailedFx(() => db, redis, frozen, new Date(), NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a Redis error is fail-open: no throw, nothing probed', async () => {
    const redis = fakeRecheck('GBP');
    redis.failing = true;
    const fx = vi.fn<FxRatesFn>(async () => live());
    expect(await recheckFailedFx(() => db, redis, fx, new Date(), NO_STAGGER)).toBe(0);
    expect(fx).not.toHaveBeenCalled();
    // ...and a sweep whose list write fails still alerts as before.
    expect(await sweepFxHealth(db, async (c) => { throw new RateUnavailableError('timeout', c); }, new Date(), {
      ...NO_STAGGER, recheck: redis,
    })).toBe(1);
  });
});

// Step 0 FX-4: a FROZEN feed answers every fetch (fetchedAt is fresh), so only
// the fixing date shows it. The sweep is pure in `now`: every case passes its
// own clock and stamps fetchedAt from it (no dependence on the real date).
describe('sweepFxHealth — Step 0 FX-4: the frozen-feed (FIXING) alert', () => {
  const MON_1730 = new Date('2026-10-05T17:30:00Z'); // Monday's fixing overdue under the ALERT rule
  const TUE_1730 = new Date('2026-10-06T17:30:00Z');
  const WED_0600 = new Date('2026-10-07T06:00:00Z'); // Fri fixing: REFUSE-lag 2 (Mon, Tue due) — not yet 3
  const THU_0600 = new Date('2026-10-08T06:00:00Z'); // REFUSE-lag 3 (Mon, Tue, Wed)
  const NO_STAGGER = { staggerMs: 0 };
  const dated = (now: Date, asOf: string | undefined, only?: CurrencyCode[]): FxRatesFn => async (c) => ({
    toInr: 95.82, toUsd: 1, fetchedAt: now.getTime(), source: 'live',
    asOf: !only || only.includes(c) ? asOf : now.toISOString().slice(0, 10),
  });
  const messages = async (): Promise<string[]> => {
    const r = await db.execute(sql`SELECT payload FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ payload: { message: string } }> }).rows.map((x) => x.payload.message);
  };
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('one overdue fixing raises ONE combined FIXING alert keyed on (asOf, lag)', async () => {
    expect(await sweepFxHealth(db, dated(MON_1730, '2026-10-02'), MON_1730, NO_STAGGER)).toBe(1);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['fx-health:FIXING:2026-10-02:1']);
    const [message] = await messages();
    expect(message).toContain('FIXING');
    expect(message).toContain('2026-10-02');
    for (const c of FX_PROBE_CURRENCIES) expect(message).toContain(c);
    expect(message).not.toMatch(/\d{7,}/);
  });

  it('re-running at the same lag adds nothing; a growing lag alerts again', async () => {
    await sweepFxHealth(db, dated(MON_1730, '2026-10-02'), MON_1730, NO_STAGGER);
    expect(await sweepFxHealth(db, dated(MON_1730, '2026-10-02'), new Date(MON_1730.getTime() + 2 * 3_600_000), NO_STAGGER)).toBe(0);
    expect(await sweepFxHealth(db, dated(TUE_1730, '2026-10-02'), TUE_1730, NO_STAGGER)).toBe(1);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual([
      'fx-health:FIXING:2026-10-02:1', 'fx-health:FIXING:2026-10-02:2',
    ]);
  });

  it('only the stalled currency is named when one feed stalls alone', async () => {
    await sweepFxHealth(db, dated(MON_1730, '2026-10-02', ['SGD']), MON_1730, NO_STAGGER);
    const [message] = await messages();
    expect(message).toContain('SGD');
    expect(message).not.toContain('USD');
  });

  it('a current fixing (lag 0) raises nothing', async () => {
    expect(await sweepFxHealth(db, dated(MON_1730, '2026-10-05'), MON_1730, NO_STAGGER)).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('no fixing date: no FIXING alert, one fx.no-fixing-date warn line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sweepFxHealth(db, dated(MON_1730, undefined), MON_1730, NO_STAGGER)).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('fx.no-fixing-date'))).toHaveLength(1);
  });

  it('gate OFF: REFUSE-lag 3 alerts FIXING only (quotes still price)', async () => {
    await sweepFxHealth(db, dated(THU_0600, '2026-10-02'), THU_0600, NO_STAGGER);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['fx-health:FIXING:2026-10-02:3']);
  });

  it('gate ON: REFUSE-lag 3 also lists the currency as UNAVAILABLE (stale_fixing); lag 2 does not', async () => {
    vi.stubEnv('FX_FIXING_GATE_ENABLED', 'true');
    await sweepFxHealth(db, dated(WED_0600, '2026-10-02'), WED_0600, NO_STAGGER);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['fx-health:FIXING:2026-10-02:2']);
    await sweepFxHealth(db, dated(THU_0600, '2026-10-02', ['GBP']), THU_0600, NO_STAGGER);
    const hour = Math.floor(THU_0600.getTime() / 3_600_000);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual([
      'fx-health:FIXING:2026-10-02:2', `fx-health:UNAVAILABLE:${hour}`, 'fx-health:FIXING:2026-10-02:3',
    ]);
    const msgs = await messages();
    expect(msgs[1]).toContain('GBP (stale_fixing)');
    expect(msgs[1]).not.toContain('USD');
  });
});
