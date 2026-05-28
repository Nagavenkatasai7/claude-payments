import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike, Store } from './store';
import type { CustomerStore } from './customer-store';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Schedule } from './types';

export function createScheduleStore(
  redis: RedisLike,
  customerStore: CustomerStore,
) {
  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const raw = await redis.get(`schedule:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Schedule;
      if (!parsed.partnerId) {
        // Lazy fill from the owning customer (in-memory only — never persist
        // here; the cron pass is the only writer for backfilled records).
        const c = await customerStore.getCustomer(parsed.phone);
        parsed.partnerId = c?.partnerId ?? DEFAULT_PARTNER_ID;
      }
      return parsed;
    },
    async saveSchedule(schedule: Schedule): Promise<void> {
      await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
      await redis.sadd('schedules:ids', schedule.id);
    },
    async listSchedules(): Promise<Schedule[]> {
      const ids = await redis.smembers('schedules:ids');
      const all = await Promise.all(ids.map((id) => this.getSchedule(id)));
      return all
        .filter((s): s is Schedule => s !== null)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    },
    async listActiveSchedules(): Promise<Schedule[]> {
      return (await this.listSchedules()).filter((s) => s.status === 'active');
    },
  };
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

let cached: ScheduleStore | null = null;

export function getScheduleStore(): ScheduleStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    const store: Store = getStore();
    const customerStore = getCustomerStore(store);
    cached = createScheduleStore(redis as unknown as RedisLike, customerStore);
  }
  return cached;
}
