import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { Schedule } from './types';

export function createScheduleStore(redis: RedisLike) {
  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const raw = await redis.get(`schedule:${id}`);
      return raw ? (JSON.parse(raw) as Schedule) : null;
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
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    cached = createScheduleStore(redis as unknown as RedisLike);
  }
  return cached;
}
