import type { GateRedis } from '@/lib/worker-gate';

/**
 * In-memory stand-in for the Upstash commands the worker gate uses — the four
 * sorted-set commands (ZADD / ZCOUNT / ZREM / ZREMRANGEBYSCORE) plus GET / SET
 * for the `worker:lastFullAt` marker — with Upstash's call shapes
 * (@upstash/redis 1.38.1 error-8y4qG0W2.d.ts:2611-2633, 2757-2763, 4313,
 * 4636, 4800-4864). `failing = true` makes every call reject (the fail-open
 * paths). Strings live apart from the sorted sets, so `dump(DUE_KEY)` stays
 * exact. `calls` logs each command in order (`zadd:<member>`, `trim`, …).
 */
export interface FakeGateRedis extends GateRedis {
  /** member → score, per key (read-only view for assertions). */
  dump(key: string): Map<string, number>;
  /** The plain string keys (GET/SET). */
  strings: Map<string, string>;
  /** Every command, in call order. */
  calls: string[];
  failing: boolean;
}

function bound(v: number | string): number {
  if (v === '-inf') return -Infinity;
  if (v === '+inf') return Infinity;
  return Number(v);
}

export function fakeGateRedis(): FakeGateRedis {
  const zsets = new Map<string, Map<string, number>>();
  const z = (key: string) => {
    let m = zsets.get(key);
    if (!m) {
      m = new Map();
      zsets.set(key, m);
    }
    return m;
  };
  const self: FakeGateRedis = {
    failing: false,
    strings: new Map(),
    calls: [],
    dump: (key) => new Map(z(key)),
    async get(key) {
      self.calls.push(`get:${key}`);
      if (self.failing) throw new Error('upstash down');
      return self.strings.get(key) ?? null;
    },
    async set(key, value) {
      self.calls.push(`set:${key}`);
      if (self.failing) throw new Error('upstash down');
      self.strings.set(key, value);
      return 'OK';
    },
    async zadd(key, sm) {
      self.calls.push(`zadd:${sm.member}`);
      if (self.failing) throw new Error('upstash down');
      const m = z(key);
      const added = m.has(sm.member) ? 0 : 1;
      m.set(sm.member, sm.score);
      return added;
    },
    async zcount(key, min, max) {
      self.calls.push('zcount');
      if (self.failing) throw new Error('upstash down');
      const lo = bound(min);
      const hi = bound(max);
      return [...z(key).values()].filter((s) => s >= lo && s <= hi).length;
    },
    async zrem(key, ...members) {
      self.calls.push(`zrem:${members.join(',')}`);
      if (self.failing) throw new Error('upstash down');
      let n = 0;
      for (const mem of members) if (z(key).delete(mem)) n++;
      return n;
    },
    async zremrangebyscore(key, min, max) {
      self.calls.push('trim');
      if (self.failing) throw new Error('upstash down');
      const lo = bound(min);
      const hi = bound(max);
      let n = 0;
      for (const [mem, s] of z(key)) {
        if (s >= lo && s <= hi) {
          z(key).delete(mem);
          n++;
        }
      }
      return n;
    },
  };
  return self;
}
