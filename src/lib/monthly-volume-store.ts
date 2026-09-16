import { getRedis } from './redis';
import { getStore } from './store';
import { easternMonth } from './dates';
import { legacyKeyAllowed, type LegacyTenantOf } from './legacy-tenant';
import type { RedisLike } from './store';
import type { PartnerId } from './types';

const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60; // keep last month for late audits / rollover

// Keyed by (tenant, phone) since fix 1 — a phone is not a global identity, so a
// partner-API send for a number can never move another tenant's monthly cap.
// TRANSITIONAL (delete in fix 10): an absent tenant key reads through to the
// pre-fix phone-only key ONLY for the phone's pre-fix tenant (legacyKeyAllowed,
// D9 oldest-row rule) and the next add absorbs it, so no in-flight cap resets
// and a post-fix sibling tenant never inherits another tenant's spend. With no
// resolver (tests, or a caller that has none) there is no fallback at all.
export function createMonthlyVolumeStore(redis: RedisLike, legacyTenantOf?: LegacyTenantOf) {
  function key(partnerId: PartnerId, senderPhone: string): string {
    return `monthly_volume:${partnerId}:${senderPhone}:${easternMonth(Date.now())}`;
  }
  function legacyKey(senderPhone: string): string {
    return `monthly_volume:${senderPhone}:${easternMonth(Date.now())}`;
  }
  async function read(partnerId: PartnerId, senderPhone: string): Promise<number> {
    const raw = await redis.get(key(partnerId, senderPhone));
    if (raw !== null) return Number(raw);
    if (!(await legacyKeyAllowed(partnerId, senderPhone, legacyTenantOf))) return 0;
    const legacy = await redis.get(legacyKey(senderPhone));
    return legacy ? Number(legacy) : 0;
  }

  return {
    async getMonthCents(partnerId: PartnerId, senderPhone: string): Promise<number> {
      return read(partnerId, senderPhone);
    },

    async addCents(partnerId: PartnerId, senderPhone: string, cents: number): Promise<void> {
      const current = await read(partnerId, senderPhone);
      await redis.set(key(partnerId, senderPhone), String(current + cents), { ex: MONTH_TTL_SECONDS });
    },
  };
}

export type MonthlyVolumeStore = ReturnType<typeof createMonthlyVolumeStore>;

let cached: MonthlyVolumeStore | null = null;

export function getMonthlyVolumeStore(): MonthlyVolumeStore {
  if (!cached) {
    cached = createMonthlyVolumeStore(getRedis(), getStore().legacyTenantOf); // D9: the store owns the resolver
  }
  return cached;
}
