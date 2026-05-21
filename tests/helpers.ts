import type { RedisLike } from '@/lib/store';

export interface FakeRedis extends RedisLike {
  dump: Map<string, string>;
}

export function fakeRedis(): FakeRedis {
  const map = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
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
  };
}
