import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import {
  WORKER_CRON_PERIOD_MIN,
  DRAIN_SLA_MINUTES,
  CRON_QUIET_MINUTES,
  CRON_MARKER_KEY,
  invocationSource,
  shouldProbeFx,
  recordCronRun,
  checkCronQuiet,
  sweepDrainGap,
  getCadenceSnapshot,
} from '@/lib/worker-cadence';
import type { Db } from '@/db/client';
import type { RedisLike } from '@/lib/store';

// worker-cadence — Program-Fix 12 (Task 8). The Vercel per-minute cron is the
// worker's clock; this module labels the invocation, gates the FX probe, keeps
// the last-cron marker in Redis and raises the two alarms (quiet cron, drain
// gap). Redis is fail-open everywhere: it may slow nothing and fail nothing.

const ROOT = join(__dirname, '..');
const VERCEL_JSON = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  crons: Array<{ path: string; schedule: string }>;
  ignoreCommand: string;
};

// `* * * * *` is 1; `*&#47;N * * * *` (every N minutes) is N. Anything else is not a per-minute schedule.
function periodMinutes(schedule: string): number {
  const [minute, ...rest] = schedule.trim().split(/\s+/);
  if (rest.join(' ') !== '* * * *') throw new Error(`not a per-minute schedule: ${schedule}`);
  if (minute === '*') return 1;
  const m = /^\*\/(\d+)$/.exec(minute);
  if (!m) throw new Error(`not a per-minute schedule: ${schedule}`);
  return Number(m[1]);
}

function throwingRedis(): RedisLike {
  const boom = async () => {
    throw new Error('upstash down');
  };
  return { ...fakeRedis(), get: boom, set: boom } as unknown as RedisLike;
}

async function alertKeys(db: Db): Promise<string[]> {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((x) => x.dedupe_key);
}

describe('vercel.json — the cron config (test 1)', () => {
  it('has exactly one /api/worker cron on `* * * * *`', () => {
    const workers = VERCEL_JSON.crons.filter((c) => c.path === '/api/worker');
    expect(workers).toEqual([{ path: '/api/worker', schedule: '* * * * *' }]);
  });

  it('keeps the daily /api/cron entry and ignoreCommand byte-for-byte (values at 7d734cf)', () => {
    expect(VERCEL_JSON.crons.filter((c) => c.path === '/api/cron')).toEqual([
      { path: '/api/cron', schedule: '0 13 * * *' },
    ]);
    expect(VERCEL_JSON.ignoreCommand).toBe(
      'if [ "${VERCEL_GIT_COMMIT_REF#component/}" != "$VERCEL_GIT_COMMIT_REF" ]; then exit 0; else exit 1; fi',
    );
  });
});

describe('alarm thresholds follow the schedule (test 2)', () => {
  it('the constants cannot fall out of step with vercel.json', () => {
    const period = periodMinutes(VERCEL_JSON.crons.find((c) => c.path === '/api/worker')!.schedule);
    expect(period).toBe(WORKER_CRON_PERIOD_MIN);
    expect(DRAIN_SLA_MINUTES).toBeGreaterThanOrEqual(period + 5);
    expect(CRON_QUIET_MINUTES).toBeGreaterThanOrEqual(2 * period + 5);
  });
});

describe('invocationSource (test 3)', () => {
  it('GET with x-vercel-cron-schedule is cron; plain GET is heartbeat; POST is poke', () => {
    expect(invocationSource('GET', new Headers({ 'x-vercel-cron-schedule': '* * * * *' }))).toBe('cron');
    expect(invocationSource('GET', new Headers())).toBe('heartbeat');
    expect(invocationSource('POST', new Headers())).toBe('poke');
    // The label never authenticates: a POST with the header is still a poke.
    expect(invocationSource('POST', new Headers({ 'x-vercel-cron-schedule': '* * * * *' }))).toBe('poke');
  });
});

describe('shouldProbeFx (test 4)', () => {
  it('heartbeat always; cron only on a :x0 minute; poke never', () => {
    expect(shouldProbeFx('heartbeat', new Date('2026-09-22T10:11:00Z'))).toBe(true);
    expect(shouldProbeFx('cron', new Date('2026-09-22T10:10:00Z'))).toBe(true);
    expect(shouldProbeFx('cron', new Date('2026-09-22T10:11:00Z'))).toBe(false);
    expect(shouldProbeFx('poke', new Date('2026-09-22T10:10:00Z'))).toBe(false);
    expect(shouldProbeFx('poke', new Date('2026-09-22T10:11:00Z'))).toBe(false);
  });
});

describe('cron marker (test 5)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('recordCronRun then getCadenceSnapshot returns lastCronAt (a TTL is set)', async () => {
    const redis = fakeRedis();
    const setCalls: Array<{ key: string; opts?: { ex?: number } }> = [];
    const origSet = redis.set.bind(redis);
    redis.set = async (key, value, opts) => {
      setCalls.push({ key, opts });
      return origSet(key, value, opts);
    };
    const at = new Date('2026-09-22T10:10:30Z');
    await recordCronRun(redis, at);
    expect(setCalls).toEqual([{ key: CRON_MARKER_KEY, opts: { ex: 30 * 24 * 3600 } }]);
    const snap = await getCadenceSnapshot(db, redis);
    expect(snap.lastCronAt?.toISOString()).toBe(at.toISOString());
    expect(snap).toMatchObject({ dueNow: 0, oldestDueAt: null });
  });

  it('a throwing Redis never throws out of recordCronRun / getCadenceSnapshot; lastCronAt is null', async () => {
    const redis = throwingRedis();
    await expect(recordCronRun(redis, new Date())).resolves.toBeUndefined();
    const snap = await getCadenceSnapshot(db, redis);
    expect(snap.lastCronAt).toBeNull();
  });

  it('a garbage marker reads as absent', async () => {
    const redis = fakeRedis();
    await redis.set(CRON_MARKER_KEY, 'not-a-date');
    expect((await getCadenceSnapshot(db, redis)).lastCronAt).toBeNull();
  });
});

describe('checkCronQuiet (test 6)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('a marker 11 min old raises ONE cronquiet alert per hour OF QUIETNESS, keyed on the outage, not the wall clock', async () => {
    const redis = fakeRedis();
    // The outage starts at 10:44; the heartbeat checks at 10:55 and again at
    // 11:05 — across a wall-clock hour boundary. One outage, one alert.
    const lastCron = new Date('2026-09-22T10:44:00Z');
    await recordCronRun(redis, lastCron);
    const first = await checkCronQuiet(db, redis, new Date('2026-09-22T10:55:00Z'));
    expect(first).toMatchObject({ breached: true, alerted: true });
    expect(first.lastCronAt?.toISOString()).toBe(lastCron.toISOString());
    expect(await alertKeys(db)).toEqual([`cronquiet:${lastCron.getTime()}:0`]);
    const second = await checkCronQuiet(db, redis, new Date('2026-09-22T11:05:00Z'));
    expect(second).toMatchObject({ breached: true, alerted: false });
    expect(await alertKeys(db)).toHaveLength(1);
    // The second hour of the SAME outage re-alerts once.
    const third = await checkCronQuiet(db, redis, new Date('2026-09-22T11:50:00Z'));
    expect(third).toMatchObject({ breached: true, alerted: true });
    expect(await alertKeys(db)).toEqual([`cronquiet:${lastCron.getTime()}:0`, `cronquiet:${lastCron.getTime()}:1`]);
    // The cron resumes, then stops again: a new outage has a new key.
    const resumed = new Date('2026-09-22T12:00:00Z');
    await recordCronRun(redis, resumed);
    const fourth = await checkCronQuiet(db, redis, new Date('2026-09-22T12:20:00Z'));
    expect(fourth).toMatchObject({ breached: true, alerted: true });
    expect(await alertKeys(db)).toHaveLength(3);
    expect((await alertKeys(db))[2]).toBe(`cronquiet:${resumed.getTime()}:0`);
  });

  it('a marker 2 min old raises nothing', async () => {
    const redis = fakeRedis();
    const now = new Date('2026-09-22T10:30:00Z');
    await recordCronRun(redis, new Date(now.getTime() - 2 * 60_000));
    expect(await checkCronQuiet(db, redis, now)).toMatchObject({ breached: false, alerted: false });
    expect(await alertKeys(db)).toEqual([]);
  });

  it('an absent marker raises nothing (first deploy / rolling release must not false-alarm)', async () => {
    const r = await checkCronQuiet(db, fakeRedis(), new Date());
    expect(r).toEqual({ lastCronAt: null, breached: false, alerted: false });
    expect(await alertKeys(db)).toEqual([]);
  });

  it('a Redis throw raises nothing and does not throw', async () => {
    const r = await checkCronQuiet(db, throwingRedis(), new Date());
    expect(r).toEqual({ lastCronAt: null, breached: false, alerted: false });
    expect(await alertKeys(db)).toEqual([]);
  });

  it('the alert text carries only the age — never a payload', async () => {
    const redis = fakeRedis();
    const now = new Date();
    await recordCronRun(redis, new Date(now.getTime() - 25 * 60_000));
    await checkCronQuiet(db, redis, now);
    const r = await db.execute(sql`SELECT payload FROM outbox WHERE kind = 'ops.alert'`);
    const payload = (r as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0].payload;
    expect(Object.keys(payload)).toEqual(['message']);
    expect(payload.message).toContain('25m');
    expect(payload.message).toContain(String(CRON_QUIET_MINUTES));
  });
});

describe('sweepDrainGap (test 7)', () => {
  let db: Db;
  let outbox: ReturnType<typeof createOutboxRepo>;
  beforeEach(async () => {
    db = await freshDb();
    outbox = createOutboxRepo(db);
  });

  it('a pending row due 11 min ago raises ONE draingap alert per hour bucket', async () => {
    await outbox.enqueue('whatsapp.text', { to: 'x', text: 'y' });
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '11 minutes'`);
    const now = new Date();
    const first = await sweepDrainGap(db, now);
    expect(first).toMatchObject({ dueNow: 1, breached: true, alerted: true });
    expect(first.oldestDueAt!.getTime()).toBeLessThan(now.getTime() - 10 * 60_000);
    const bucket = Math.floor(now.getTime() / 3_600_000);
    expect(await alertKeys(db)).toEqual([`draingap:${bucket}`]);
    const second = await sweepDrainGap(db, now);
    // The alert row itself is now due, so dueNow grows — but nothing is re-enqueued.
    expect(second).toMatchObject({ dueNow: 2, breached: true, alerted: false });
    expect(await alertKeys(db)).toHaveLength(1);
  });

  it('a row due 2 min ago raises nothing', async () => {
    await outbox.enqueue('whatsapp.text', { to: 'x', text: 'y' });
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '2 minutes'`);
    const r = await sweepDrainGap(db, new Date());
    expect(r).toMatchObject({ dueNow: 1, breached: false, alerted: false });
    expect(await alertKeys(db)).toEqual([]);
  });

  it('a processing row whose lease expired 11 min ago counts as due', async () => {
    await outbox.enqueue('settlement.instruct', { transferId: 't1' });
    const [row] = await outbox.claimBatch(1, 'w_dead');
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '11 minutes' WHERE id = ${row.id}`);
    const r = await sweepDrainGap(db, new Date());
    expect(r).toMatchObject({ dueNow: 1, breached: true, alerted: true });
  });

  it('a live lease and a future next_attempt_at do not count', async () => {
    await outbox.enqueue('settlement.instruct', { transferId: 't1' });
    await outbox.claimBatch(1, 'w_alive');
    await outbox.enqueue('whatsapp.text', { to: 'x', text: 'y' }, { delayMs: 60 * 60_000 });
    const r = await sweepDrainGap(db, new Date());
    expect(r).toEqual({ dueNow: 0, oldestDueAt: null, breached: false, alerted: false });
    expect(await alertKeys(db)).toEqual([]);
  });
});

describe('no stale cadence promise in code or docs (test 10)', () => {
  // Mirrors: grep -rn -i "5-minute heartbeat\|5-min heartbeat\|delivery guarantee\|heartbeat is the\|every 5 minutes"
  //   src scripts CLAUDE.md docs/*.md docs/diagrams .github/workflows
  // minus docs/AUDIT-2026-09-14.md (a dated audit record) and the rendered
  // diagram images (*.svg, *.png): the repo has no mermaid renderer, so the
  // .mmd sources are corrected here and the renders stay until regenerated.
  // Under this pattern BOTH renders are stale today:
  //   docs/diagrams/architecture-L2-containers.svg ("wakes the worker every 5 minutes")
  //   docs/diagrams/architecture-L3-flaws.svg      ("delivery guarantee")
  // Regenerating them from the corrected .mmd (mermaid.live) clears both.
  const STALE = /5-minute heartbeat|5-min heartbeat|delivery guarantee|heartbeat is the|every 5 minutes/i;
  const TEXT = new Set(['.ts', '.tsx', '.md', '.mmd', '.yml', '.yaml', '.json', '.mjs', '.sh']);

  function walk(dir: string, out: string[], recurse: boolean): void {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (recurse) walk(p, out, true);
        continue;
      }
      if (TEXT.has(extname(name))) out.push(p);
    }
  }

  it('grep gives no hits outside the audit record and the rendered images', () => {
    const files: string[] = [join(ROOT, 'CLAUDE.md')];
    walk(join(ROOT, 'src'), files, true);
    walk(join(ROOT, 'scripts'), files, true);
    walk(join(ROOT, 'docs'), files, false);
    walk(join(ROOT, 'docs', 'diagrams'), files, true);
    walk(join(ROOT, '.github', 'workflows'), files, true);
    const hits: string[] = [];
    for (const f of files) {
      if (f.endsWith('docs/AUDIT-2026-09-14.md')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (STALE.test(line)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
