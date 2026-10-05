import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  FLAG_CACHE_TTL_MS,
  FLAG_DEFINITIONS,
  FLAG_KEYS,
  SendsPausedError,
  activeKillSwitches,
  invalidateFlagCache,
  isFlagOn,
  isKnownFlagKey,
  matchingRows,
} from '@/lib/flags';
import { createFeatureFlagRepo, type FlagRow } from '@/db/repos/feature-flag-repo';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Release safety Batch 2 part A: the flag table, isFlagOn and the sends.paused
// kill switch at the mint chokepoint.

const row = (over: Partial<FlagRow>): FlagRow => ({
  key: 'sends.paused',
  scopeType: 'global',
  scopeId: '',
  enabled: true,
  reason: 'test reason',
  updatedBy: 'admin',
  updatedAt: new Date(),
  ...over,
});

async function setFlag(db: Db, key: string, scopeType: 'global' | 'partner' | 'corridor', scopeId: string, enabled = true) {
  await createFeatureFlagRepo(db).upsert({ key, scopeType, scopeId, enabled, reason: 'test pause reason', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

describe('flag definitions', () => {
  it('defines the two kill switches with every scope', () => {
    expect(FLAG_KEYS.sort()).toEqual(['sends.paused', 'settlement.paused']);
    for (const k of FLAG_KEYS) {
      expect(FLAG_DEFINITIONS[k].killSwitch).toBe(true);
      expect(FLAG_DEFINITIONS[k].scopes).toEqual(['global', 'partner', 'corridor']);
    }
  });

  it('isKnownFlagKey accepts only defined keys', () => {
    expect(isKnownFlagKey('sends.paused')).toBe(true);
    expect(isKnownFlagKey('settlement.paused')).toBe(true);
    expect(isKnownFlagKey('sanctions.off')).toBe(false);
    expect(isKnownFlagKey('toString')).toBe(false);
    expect(isKnownFlagKey(undefined)).toBe(false);
  });
});

describe('matchingRows (pure)', () => {
  it('a global row matches every request', () => {
    expect(matchingRows([row({})], 'sends.paused', {})).toHaveLength(1);
    expect(matchingRows([row({})], 'sends.paused', { partnerId: 'acme', corridor: 'IN' })).toHaveLength(1);
  });

  it('a partner row matches only that partner (any of several)', () => {
    const rows = [row({ scopeType: 'partner', scopeId: 'acme' })];
    expect(matchingRows(rows, 'sends.paused', { partnerId: 'acme' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { partnerId: ['default', 'acme'] })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { partnerId: 'default' })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', { partnerId: [null, undefined] })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', {})).toHaveLength(0);
  });

  it('a corridor row matches only that destination country, case-insensitive', () => {
    const rows = [row({ scopeType: 'corridor', scopeId: 'IN' })];
    expect(matchingRows(rows, 'sends.paused', { corridor: 'IN' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { corridor: 'in' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { corridor: 'PH' })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', {})).toHaveLength(0);
  });

  it('ignores disabled rows and other keys', () => {
    expect(matchingRows([row({ enabled: false })], 'sends.paused', {})).toHaveLength(0);
    expect(matchingRows([row({ key: 'settlement.paused' })], 'sends.paused', {})).toHaveLength(0);
  });
});

describe('isFlagOn (Postgres)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    invalidateFlagCache(db);
  });
  afterEach(() => {
    invalidateFlagCache(db);
    vi.restoreAllMocks();
  });

  it('no rows ⇒ off', async () => {
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default', corridor: 'IN' })).toBe(false);
  });

  it('reads global, partner and corridor rows', async () => {
    await setFlag(db, 'sends.paused', 'partner', 'acme');
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'acme' })).toBe(true);
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'sends.paused', 'corridor', 'PH');
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default', corridor: 'PH' })).toBe(true);
    await setFlag(db, 'settlement.paused', 'global', '');
    expect(await isFlagOn(db, 'settlement.paused', {})).toBe(true);
  });

  it('an upsert turns a row off again (one row per key and scope)', async () => {
    await setFlag(db, 'sends.paused', 'global', '');
    expect(await isFlagOn(db, 'sends.paused')).toBe(true);
    await setFlag(db, 'sends.paused', 'global', '', false);
    expect(await isFlagOn(db, 'sends.paused')).toBe(false);
    expect(await createFeatureFlagRepo(db).listAll()).toHaveLength(1);
  });

  it('caches the snapshot for FLAG_CACHE_TTL_MS per instance', async () => {
    const t0 = 1_000_000;
    expect(await isFlagOn(db, 'sends.paused', {}, t0)).toBe(false);
    // A write without invalidation is invisible until the TTL passes.
    await createFeatureFlagRepo(db).upsert({
      key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'cache test', updatedBy: 'admin',
    });
    expect(await isFlagOn(db, 'sends.paused', {}, t0 + FLAG_CACHE_TTL_MS - 1)).toBe(false);
    expect(await isFlagOn(db, 'sends.paused', {}, t0 + FLAG_CACHE_TTL_MS)).toBe(true);
  });

  it('a read failure is off (fail open) and never throws', async () => {
    const broken = {
      select: () => {
        throw new Error('neon down');
      },
    } as unknown as Db;
    expect(await isFlagOn(broken, 'sends.paused')).toBe(false);
    expect(await activeKillSwitches(broken)).toEqual([]);
  });

  it('the CHECK constraints refuse an unknown scope type and a global row with a scope id', async () => {
    await expect(
      db.execute(sql`INSERT INTO feature_flags (key, scope_type, scope_id, enabled, updated_by) VALUES ('sends.paused','team','x',true,'a')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO feature_flags (key, scope_type, scope_id, enabled, updated_by) VALUES ('sends.paused','global','x',true,'a')`),
    ).rejects.toThrow();
  });

  it('activeKillSwitches lists only enabled rows of known kill-switch keys', async () => {
    await setFlag(db, 'sends.paused', 'corridor', 'IN');
    await setFlag(db, 'settlement.paused', 'global', '', false);
    await createFeatureFlagRepo(db).upsert({
      key: 'unknown.key', scopeType: 'global', scopeId: '', enabled: true, reason: 'x', updatedBy: 'a',
    });
    invalidateFlagCache(db);
    const active = await activeKillSwitches(db);
    expect(active.map((r) => `${r.key}:${r.scopeType}:${r.scopeId}`)).toEqual(['sends.paused:corridor:IN']);
  });
});

describe('sends.paused at the mint chokepoint (createTransferWithOutcome)', () => {
  const base = {
    phone: '15551234567',
    amountSource: 50,
    sourceCurrency: 'USD' as const,
    partnerId: 'default',
    recipientName: 'Mom',
    recipientPhone: '919133001840',
    payoutMethod: 'upi' as const,
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer' as const,
    senderKycStatus: 'verified' as const,
  };

  async function makeStores() {
    const redis = fakeRedis();
    const db = await freshDb();
    invalidateFlagCache(db);
    return { db, store: createStore(redis, db), partnerStore: createPartnerStore(db), mvs: createMonthlyVolumeStore(createStore(redis, db)) };
  }

  beforeEach(() => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function countTransfers(db: Db): Promise<number> {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM transfers`);
    return Number((r as unknown as { rows: Array<{ n: number }> }).rows[0].n);
  }

  it('a global pause refuses the mint and writes nothing (no transfer, no audit row)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    await expect(createTransfer(store, partnerStore, mvs, base)).rejects.toBeInstanceOf(SendsPausedError);
    expect(await countTransfers(db)).toBe(0);
    const audits = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
    expect(Number((audits as unknown as { rows: Array<{ n: number }> }).rows[0].n)).toBe(0);
    invalidateFlagCache(db);
  });

  it('a partner pause refuses only that partner', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await setFlag(db, 'sends.paused', 'partner', 'acme');
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' })).rejects.toBeInstanceOf(SendsPausedError);
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.status).toBe('awaiting_payment');
    invalidateFlagCache(db);
  });

  it('a corridor pause refuses only that destination country (default IN)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'corridor', 'PH');
    const t = await createTransfer(store, partnerStore, mvs, base); // IN: not paused
    expect(t.status).toBe('awaiting_payment');
    await setFlag(db, 'sends.paused', 'corridor', 'IN');
    await expect(createTransfer(store, partnerStore, mvs, base)).rejects.toBeInstanceOf(SendsPausedError);
    invalidateFlagCache(db);
  });

  it('a pause on the routed rail partner refuses a routed mint', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'railco');
    await setFlag(db, 'sends.paused', 'partner', 'railco');
    const quote = {
      amountUsd: 50, feeUsd: 0, totalChargeUsd: 50, fxRate: 85, amountInr: 4250,
      amountSource: 50, feeSource: 0, totalChargeSource: 50,
    };
    await expect(
      createTransfer(store, partnerStore, mvs, { ...base, quote, settlementPartnerId: 'railco' }),
    ).rejects.toBeInstanceOf(SendsPausedError);
    invalidateFlagCache(db);
  });

  it('a sandbox (test-key) mint is never paused', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, environment: 'test' });
    expect(t.environment).toBe('test');
    invalidateFlagCache(db);
  });

  it('the refusal comes before the KYC backstop is bypassed: an unverified sender still gets kyc_required first', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    await expect(
      createTransfer(store, partnerStore, mvs, { ...base, senderKycStatus: 'not_started' }),
    ).rejects.toThrow('kyc_required');
    invalidateFlagCache(db);
  });
});
