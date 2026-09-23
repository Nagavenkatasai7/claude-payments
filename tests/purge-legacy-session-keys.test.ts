import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import { purgeLegacySessionKeys, type PurgeRedis } from '../scripts/purge-legacy-session-keys';

/**
 * Program-Fix 20 — owner-run sweep of the pre-fix plaintext session keys.
 * Dry run (default) only COUNTS; --delete removes exactly the legacy patterns.
 * `scan` is an injected stub that pages through the fake's keys with a string
 * cursor like Upstash; the output carries counts only, never a key or value.
 */

function withScan(pageSize = 2) {
  const r = fakeRedis();
  const allKeys = () => [...new Set([...r.dump.keys(), ...r.sets.keys()])].sort();
  const scan = vi.fn(async (cursor: string | number, opts: { match: string; count?: number }) => {
    const re = new RegExp('^' + opts.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const keys = allKeys();
    const start = Number(cursor);
    const page = keys.slice(start, start + pageSize).filter((k) => re.test(k));
    const next = start + pageSize >= keys.length ? '0' : String(start + pageSize);
    return [next, page] as [string, string[]];
  });
  const del = vi.spyOn(r, 'del');
  const redis: PurgeRedis = { scan, del: (k: string) => r.del(k) };
  return { r, redis, scan, del };
}

async function seed(r: ReturnType<typeof fakeRedis>) {
  await r.set('session:aaaa', 'priya');
  await r.set('session:bbbb', 'admin');
  await r.sadd('staff_sessions:priya', 'aaaa');
  await r.set('staff_sess:hhhh', 'priya'); // new schema: must survive
  await r.sadd('staff_sess_ix:priya', 'hhhh');
  await r.sadd('sr_sess_idx:15550102030', 'cccc');
  await r.set('sr_sess:dddd', '{"phone":"15550102030"}'); // customer record: must survive
  await r.sadd('sr_sess_ix:15550102030', 'dddd');
  await r.set('staff:priya', '{}');
}

describe('purgeLegacySessionKeys', () => {
  it('dry run counts the staff legacy keys and deletes nothing', async () => {
    const { r, redis, del } = withScan();
    await seed(r);
    const lines: string[] = [];
    const report = await purgeLegacySessionKeys(redis, { staff: true, customer: false, del: false }, (l) => lines.push(l));
    expect(report).toEqual({ 'session:*': 2, 'staff_sessions:*': 1 });
    expect(del).not.toHaveBeenCalled();
    expect(r.dump.has('session:aaaa')).toBe(true);
    // counts only — no key name or value is ever printed
    const out = lines.join('\n');
    for (const secret of ['aaaa', 'bbbb', 'priya', 'admin']) expect(out).not.toContain(secret);
  });

  it('--staff --delete removes only session:* and staff_sessions:*', async () => {
    const { r, redis } = withScan();
    await seed(r);
    await purgeLegacySessionKeys(redis, { staff: true, customer: false, del: true }, () => {});
    expect(r.dump.has('session:aaaa')).toBe(false);
    expect(r.dump.has('session:bbbb')).toBe(false);
    expect(r.sets.has('staff_sessions:priya')).toBe(false);
    expect(r.dump.get('staff_sess:hhhh')).toBe('priya');
    expect(r.sets.has('staff_sess_ix:priya')).toBe(true);
    expect(r.dump.has('staff:priya')).toBe(true);
    expect(r.sets.has('sr_sess_idx:15550102030')).toBe(true); // customer untouched
  });

  it('--customer --delete removes only the legacy index sets, never session records', async () => {
    const { r, redis } = withScan();
    await seed(r);
    const report = await purgeLegacySessionKeys(redis, { staff: false, customer: true, del: true }, () => {});
    expect(report).toEqual({ 'sr_sess_idx:*': 1 });
    expect(r.sets.has('sr_sess_idx:15550102030')).toBe(false);
    expect(r.dump.has('sr_sess:dddd')).toBe(true);
    expect(r.sets.has('sr_sess_ix:15550102030')).toBe(true);
    expect(r.dump.has('session:aaaa')).toBe(true); // staff untouched
  });

  it('pages the cursor to "0" and dedupes a key returned twice', async () => {
    const r = fakeRedis();
    await r.set('session:aaaa', 'priya');
    const scan = vi.fn(async (cursor: string | number, o: { match: string }): Promise<[string, string[]]> => {
      if (o.match !== 'session:*') return ['0', []];
      return cursor === '0' ? ['7', ['session:aaaa']] : ['0', ['session:aaaa']];
    });
    const report = await purgeLegacySessionKeys(
      { scan, del: (k: string) => r.del(k) },
      { staff: true, customer: false, del: false },
      () => {},
    );
    expect(report['session:*']).toBe(1);
    expect(scan.mock.calls.filter(([, o]) => o.match === 'session:*').map(([c]) => c)).toEqual(['0', '7']);
  });
});
