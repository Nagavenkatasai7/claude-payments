import { getRedis } from './redis';
import { easternMonth } from './dates';
import type { RedisLike } from './store';

const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60; // keep last month for late audits / rollover

export function createMonthlyVolumeStore(redis: RedisLike) {
  function key(senderPhone: string): string {
    return `monthly_volume:${senderPhone}:${easternMonth(Date.now())}`;
  }

  return {
    async getMonthCents(senderPhone: string): Promise<number> {
      const raw = await redis.get(key(senderPhone));
      return raw ? Number(raw) : 0;
    },

    async addCents(senderPhone: string, cents: number): Promise<void> {
      const k = key(senderPhone);
      const current = Number((await redis.get(k)) ?? '0');
      await redis.set(k, String(current + cents), { ex: MONTH_TTL_SECONDS });
    },
  };
}

export type MonthlyVolumeStore = ReturnType<typeof createMonthlyVolumeStore>;

let cached: MonthlyVolumeStore | null = null;

export function getMonthlyVolumeStore(): MonthlyVolumeStore {
  if (!cached) {
    cached = createMonthlyVolumeStore(getRedis());
  }
  return cached;
}
