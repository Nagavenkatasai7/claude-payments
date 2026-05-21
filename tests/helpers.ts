import type { RedisLike } from '@/lib/store';

export interface FakeRedis extends RedisLike {
  dump: Map<string, string>;
}

export function fakeRedis(): FakeRedis {
  const map = new Map<string, string>();
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
  };
}
