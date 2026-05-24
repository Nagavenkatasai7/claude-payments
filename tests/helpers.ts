import type { RedisLike } from '@/lib/store';

export interface FakeRedis extends RedisLike {
  dump: Map<string, string>;
}

export function fakeRedis(): FakeRedis {
  const map = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    dump: map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(
      key: string,
      value: string,
      opts?: { ex?: number; nx?: boolean },
    ) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      map.delete(key);
      sets.delete(key);
      hashes.delete(key);
      return 1;
    },
    async incr(key: string) {
      const next = (map.has(key) ? parseInt(map.get(key)!, 10) : 0) + 1;
      map.set(key, String(next));
      return next;
    },
    async sadd(key: string, member: string) {
      let s = sets.get(key);
      if (!s) {
        s = new Set();
        sets.set(key, s);
      }
      s.add(member);
      return 1;
    },
    async srem(key: string, member: string) {
      sets.get(key)?.delete(member);
      return 1;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async hset(key: string, fields: Record<string, string>) {
      let h = hashes.get(key);
      if (!h) {
        h = new Map();
        hashes.set(key, h);
      }
      for (const [f, v] of Object.entries(fields)) h.set(f, v);
      return Object.keys(fields).length;
    },
    async hget(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hgetall(key: string) {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h);
    },
    async hdel(key: string, field: string) {
      hashes.get(key)?.delete(field);
      return 1;
    },
    async getdel(key: string) {
      if (!map.has(key)) return null;
      const v = map.get(key)!;
      map.delete(key);
      return v;
    },
    async exists(key: string) {
      return map.has(key) || sets.has(key) || hashes.has(key) ? 1 : 0;
    },
  };
}
