import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';
import { env } from './env';
import type { RedisLike } from './store';
import type { Staff } from './types';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createAuthStore(redis: RedisLike) {
  return {
    async getStaff(username: string): Promise<Staff | null> {
      const raw = await redis.get(`staff:${username}`);
      return raw ? (JSON.parse(raw) as Staff) : null;
    },
    async saveStaff(staff: Staff): Promise<void> {
      await redis.set(`staff:${staff.username}`, JSON.stringify(staff));
      await redis.sadd('staff:index', staff.username);
    },
    async listStaff(): Promise<Staff[]> {
      const usernames = await redis.smembers('staff:index');
      const all = await Promise.all(
        usernames.map((u) => this.getStaff(u)),
      );
      return all
        .filter((s): s is Staff => s !== null)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },
    async deleteStaff(username: string): Promise<void> {
      await redis.del(`staff:${username}`);
      await redis.srem('staff:index', username);
    },
    /**
     * Stamp lastLoginAt on the freshest record only. Re-reads inside the call so a
     * stale snapshot from earlier in the login request can't resurrect a record an
     * admin just suspended (the full-object SET race). No-op if missing/suspended.
     */
    async recordLogin(username: string): Promise<void> {
      const raw = await redis.get(`staff:${username}`);
      if (!raw) return;
      const staff = JSON.parse(raw) as Staff;
      if (staff.status === 'suspended') return;
      staff.lastLoginAt = new Date().toISOString();
      await redis.set(`staff:${username}`, JSON.stringify(staff));
    },
    async createSession(username: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      await redis.set(`session:${token}`, username, {
        ex: SESSION_TTL_SECONDS,
      });
      await redis.sadd(`staff_sessions:${username}`, token);
      return token;
    },
    async getSessionUser(token: string): Promise<string | null> {
      return redis.get(`session:${token}`);
    },
    async deleteSession(token: string): Promise<void> {
      const username = await redis.get(`session:${token}`);
      await redis.del(`session:${token}`);
      if (username) await redis.srem(`staff_sessions:${username}`, token);
    },
    async deleteAllSessionsFor(username: string): Promise<void> {
      const tokens = await redis.smembers(`staff_sessions:${username}`);
      for (const t of tokens) await redis.del(`session:${t}`);
      await redis.del(`staff_sessions:${username}`);
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;

let cached: AuthStore | null = null;

export function getAuthStore(): AuthStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createAuthStore(redis as unknown as RedisLike);
  }
  return cached;
}
