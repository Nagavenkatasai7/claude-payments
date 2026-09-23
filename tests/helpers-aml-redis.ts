import type { AmlRedis } from '@/lib/aml-sweep';

// helpers-aml-redis — an in-memory stand-in for the Upstash commands the AML
// sweep uses (Program-Fix 43): strings with SET NX, sets, and sorted sets with
// ZADD GT / ZREMRANGEBYSCORE / ZREMRANGEBYRANK / ZCARD. `down = true` makes
// every call throw, like an Upstash outage. TTLs are recorded, not enforced.

export interface FakeAmlRedis extends AmlRedis {
  strings: Map<string, string>;
  sets: Map<string, Set<string>>;
  zsets: Map<string, Map<string, number>>;
  ttls: Map<string, number>;
  down: boolean;
  calls: number;
}

export function fakeAmlRedis(): FakeAmlRedis {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();
  const has = (k: string) => strings.has(k) || sets.has(k) || zsets.has(k);
  const r: FakeAmlRedis = {
    strings, sets, zsets, ttls, down: false, calls: 0,
    async get(key) {
      guard();
      return strings.get(key) ?? null;
    },
    async set(key, value, opts) {
      guard();
      if (opts?.nx && has(key)) return null;
      strings.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return 'OK';
    },
    async del(key) {
      guard();
      const had = has(key);
      strings.delete(key); sets.delete(key); zsets.delete(key);
      return had ? 1 : 0;
    },
    async exists(key) {
      guard();
      return has(key) ? 1 : 0;
    },
    async sismember(key, member) {
      guard();
      return sets.get(key)?.has(member) ? 1 : 0;
    },
    async sadd(key, member) {
      guard();
      let s = sets.get(key);
      if (!s) { s = new Set(); sets.set(key, s); }
      const added = s.has(member) ? 0 : 1;
      s.add(member);
      return added;
    },
    async expire(key, seconds) {
      guard();
      if (!has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    },
    async zadd(key, opts, sm) {
      guard();
      let z = zsets.get(key);
      if (!z) { z = new Map(); zsets.set(key, z); }
      const cur = z.get(sm.member);
      if (cur === undefined) { z.set(sm.member, sm.score); return 1; }
      if (opts.gt && sm.score <= cur) return 0;
      z.set(sm.member, sm.score);
      return 0;
    },
    async zremrangebyscore(key, min, max) {
      guard();
      const z = zsets.get(key);
      if (!z) return 0;
      const lo = min === '-inf' ? -Infinity : Number(min);
      const exclusive = typeof max === 'string' && max.startsWith('(');
      const hi = typeof max === 'string' ? Number(max.replace('(', '')) : max;
      let n = 0;
      for (const [m, s] of [...z]) {
        if (s >= lo && (exclusive ? s < hi : s <= hi)) { z.delete(m); n++; }
      }
      if (z.size === 0) zsets.delete(key);
      return n;
    },
    async zremrangebyrank(key, start, stop) {
      guard();
      const z = zsets.get(key);
      if (!z) return 0;
      const sorted = [...z].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const len = sorted.length;
      const s = start < 0 ? len + start : start;
      const e = stop < 0 ? len + stop : stop;
      let n = 0;
      for (let i = Math.max(0, s); i <= Math.min(len - 1, e); i++) { z.delete(sorted[i][0]); n++; }
      if (z.size === 0) zsets.delete(key);
      return n;
    },
    async zcard(key) {
      guard();
      return zsets.get(key)?.size ?? 0;
    },
  };
  function guard() {
    r.calls++;
    if (r.down) throw new Error('redis unavailable');
  }
  return r;
}
