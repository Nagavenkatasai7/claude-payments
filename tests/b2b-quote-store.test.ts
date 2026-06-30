import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createB2bQuoteStore } from '@/lib/b2b-quote-store';
import type { CrossBorderBillQuote } from '@/lib/b2b-quote';

const sampleQuote = (): CrossBorderBillQuote => ({
  sellerAmount: 1000,
  sellerCurrency: 'HKD',
  buyerPrincipal: 128,
  feeBuyer: 1.99,
  buyerTotal: 129.99,
  buyerCurrency: 'USD',
  fxRate: 7.8125,
});

describe('createB2bQuoteStore — quote-lock (Plan 3)', () => {
  it('locks a quote and reads it back stable (stamps lockedAt)', async () => {
    const t = 1_800_000_000_000;
    const store = createB2bQuoteStore(fakeRedis(), { now: () => t });
    const locked = await store.lockQuote('inv_1', sampleQuote());
    expect(locked.lockedAt).toBe(new Date(t).toISOString());
    expect(locked.buyerTotal).toBe(129.99);

    const got = await store.getLockedQuote('inv_1');
    expect(got?.buyerPrincipal).toBe(128);
    expect(got?.sellerAmount).toBe(1000);
    expect(got?.lockedAt).toBe(locked.lockedAt);
  });

  it('returns null for an invoice with no locked quote', async () => {
    const store = createB2bQuoteStore(fakeRedis());
    expect(await store.getLockedQuote('nope')).toBeNull();
  });

  it('expires after the TTL → null (caller re-quotes), and clears the stale key', async () => {
    const redis = fakeRedis();
    let now = 1_800_000_000_000;
    const store = createB2bQuoteStore(redis, { now: () => now });
    await store.lockQuote('inv_2', sampleQuote());

    now += 14 * 60_000; // 14 min — still within the 15-min window
    expect(await store.getLockedQuote('inv_2')).not.toBeNull();

    now += 2 * 60_000; // now 16 min — past the TTL
    expect(await store.getLockedQuote('inv_2')).toBeNull();
    // The stale key is purged on the expired read.
    expect(redis.dump.has('b2b_quote_lock:inv_2')).toBe(false);
  });

  it('a fresh lock overwrites a prior one (re-quote on expiry path)', async () => {
    let now = 1_800_000_000_000;
    const store = createB2bQuoteStore(fakeRedis(), { now: () => now });
    await store.lockQuote('inv_3', sampleQuote());
    now += 60_000;
    await store.lockQuote('inv_3', { ...sampleQuote(), buyerTotal: 142.5, buyerPrincipal: 140 });
    const got = await store.getLockedQuote('inv_3');
    expect(got?.buyerTotal).toBe(142.5);
    expect(got?.lockedAt).toBe(new Date(now).toISOString());
  });

  it('treats a corrupt payload as expired (null + purge), never throws', async () => {
    const redis = fakeRedis();
    const store = createB2bQuoteStore(redis);
    await redis.set('b2b_quote_lock:inv_4', '{not json');
    expect(await store.getLockedQuote('inv_4')).toBeNull();
    expect(redis.dump.has('b2b_quote_lock:inv_4')).toBe(false);
  });

  it('treats a parseable-but-non-object payload (e.g. "null") as corrupt — null, never throws', async () => {
    const redis = fakeRedis();
    const store = createB2bQuoteStore(redis);
    // JSON.parse('null') succeeds → null; reading .lockedAt off it would throw.
    await redis.set('b2b_quote_lock:inv_5', 'null');
    expect(await store.getLockedQuote('inv_5')).toBeNull();
    expect(redis.dump.has('b2b_quote_lock:inv_5')).toBe(false);
  });
});
