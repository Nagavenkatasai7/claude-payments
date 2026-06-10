import { getRedis } from './redis';
import { easternDate } from './dates';
import type { RedisLike } from './store';

const DAY_TTL_SECONDS = 48 * 60 * 60; // keep yesterday around for one day for late audits

export function createDailyVolumeStore(redis: RedisLike) {
  function key(senderPhone: string): string {
    return `daily_volume:${senderPhone}:${easternDate(Date.now())}`;
  }

  return {
    async getTodayCents(senderPhone: string): Promise<number> {
      const raw = await redis.get(key(senderPhone));
      return raw ? Number(raw) : 0;
    },

    async addCents(senderPhone: string, cents: number): Promise<void> {
      const k = key(senderPhone);
      const current = Number((await redis.get(k)) ?? '0');
      await redis.set(k, String(current + cents), { ex: DAY_TTL_SECONDS });
    },
  };
}

export type DailyVolumeStore = ReturnType<typeof createDailyVolumeStore>;

let cached: DailyVolumeStore | null = null;

export function getDailyVolumeStore(): DailyVolumeStore {
  if (!cached) {
    cached = createDailyVolumeStore(getRedis());
  }
  return cached;
}
