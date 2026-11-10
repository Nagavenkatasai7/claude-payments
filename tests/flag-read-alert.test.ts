import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { noteFlagReadFailure, resetFlagReadAlertMemoForTests } from '@/lib/flag-read-alert';
import { invalidateFlagCache, readFlag } from '@/lib/flags';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';

// Fix pack 3 T7 (contract 10): a failed switch-table read raises ONE ops alert
// per key and hour (`flagread:<key>:<YYYY-MM-DDTHH>`), pokes the worker, and
// never throws. The one-try memo is per instance; every test uses its own hour
// (relative to now), and the memo is reset between tests.

const box = vi.hoisted(() => ({ pokes: 0, listThrows: false }));
vi.mock('@/lib/outbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/outbox')>()),
  pokeWorker: () => {
    box.pokes += 1;
  },
}));
vi.mock('@/db/repos/feature-flag-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/feature-flag-repo')>();
  return {
    ...real,
    createFeatureFlagRepo: (db: Parameters<typeof real.createFeatureFlagRepo>[0]) => {
      const repo = real.createFeatureFlagRepo(db);
      return {
        ...repo,
        listEnabled: async () => {
          if (box.listThrows) throw new Error('neon down');
          return repo.listEnabled();
        },
      };
    },
  };
});

const HOUR = 3_600_000;
const hourKey = (now: number) => new Date(now).toISOString().slice(0, 13);

async function alerts(db: Db): Promise<Array<{ dedupe_key: string; message: string }>> {
  const r = (await db.execute(
    sql`SELECT dedupe_key, payload->>'message' AS message FROM outbox WHERE kind = 'ops.alert' ORDER BY id`,
  )) as unknown as { rows: Array<{ dedupe_key: string; message: string }> };
  return r.rows;
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  box.pokes = 0;
  box.listThrows = false;
  resetFlagReadAlertMemoForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  invalidateFlagCache(db);
  vi.restoreAllMocks();
});

describe('noteFlagReadFailure', () => {
  it('one ops.alert flagread:<key>:<YYYY-MM-DDTHH> and one poke', async () => {
    const now = Date.now() - 10 * HOUR;
    await noteFlagReadFailure(db, 'settlement.paused', now);
    expect(await alerts(db)).toEqual([
      {
        dedupe_key: `flagread:settlement.paused:${hourKey(now)}`,
        message:
          'SmartRemit ops: the switch table could not be read (settlement.paused). It reads as off; settlement on real-money rails waits.',
      },
    ]);
    expect(box.pokes).toBe(1);
  });

  it('same key, same hour: no second insert', async () => {
    const now = Date.now() - 20 * HOUR;
    await noteFlagReadFailure(db, 'sends.paused', now);
    await noteFlagReadFailure(db, 'sends.paused', now + 1000);
    expect(await alerts(db)).toHaveLength(1);
    expect(box.pokes).toBe(1);
    // Even with the memo gone (another instance), the outbox dedupe key holds.
    resetFlagReadAlertMemoForTests();
    await noteFlagReadFailure(db, 'sends.paused', now + 2000);
    expect(await alerts(db)).toHaveLength(1);
  });

  it('another key or the next hour: its own row', async () => {
    const now = Date.now() - 30 * HOUR;
    await noteFlagReadFailure(db, 'sends.paused', now);
    await noteFlagReadFailure(db, 'agent.paused', now);
    await noteFlagReadFailure(db, 'sends.paused', now + HOUR);
    expect((await alerts(db)).map((a) => a.dedupe_key)).toEqual([
      `flagread:sends.paused:${hourKey(now)}`,
      `flagread:agent.paused:${hourKey(now)}`,
      `flagread:sends.paused:${hourKey(now + HOUR)}`,
    ]);
    expect(box.pokes).toBe(3);
  });

  it('enqueue throws: no throw, no poke', async () => {
    const now = Date.now() - 40 * HOUR;
    const broken = {
      insert: () => {
        throw new Error('neon down');
      },
      select: () => {
        throw new Error('neon down');
      },
    } as unknown as Db;
    await expect(noteFlagReadFailure(broken, 'settlement.paused', now)).resolves.toBeUndefined();
    expect(box.pokes).toBe(0);
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes('flags.read-alert'))).toBe(true);
    expect(warned.join('\n')).not.toContain('neon down'); // error NAME only
  });

  it('readFlag on a failed read calls it', async () => {
    box.listThrows = true;
    const now = Date.now() - 50 * HOUR;
    expect(await readFlag(db, 'agent.tools.paused', { partnerId: 'acme' }, now)).toBe('unknown');
    expect((await alerts(db)).map((a) => a.dedupe_key)).toEqual([`flagread:agent.tools.paused:${hourKey(now)}`]);
    expect(box.pokes).toBe(1);
    // The enqueue went through the real outbox repo.
    expect(await createOutboxRepo(db).hasDedupeKey(`flagread:agent.tools.paused:${hourKey(now)}`)).toBe(true);
  });
});
