import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import { runStaffBreakGlass, parseBreakGlassArgs, type BreakGlassRedis } from '../scripts/staff-break-glass';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffLoginGuard, staffLoginKeys } from '@/lib/staff-login-guard';
import { hashPassword, verifyPassword } from '@/lib/password';
import type { Staff } from '@/lib/types';

/**
 * Program-Fix 17a — the owner-run break-glass script. Dry run by default
 * (counts only), `--apply` to write. Output never carries a username, an IP,
 * a hash or a password. `scan` is a stub paging the fake's keys like Upstash.
 */

const NOW = Date.UTC(2026, 8, 23, 10, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const SEED = 'owner-admin';
const SEED_PW = 'env-seed-password-2026';

function withScan() {
  const r = fakeRedis();
  const scan = vi.fn(async (cursor: string | number, opts: { match: string; count?: number }) => {
    const re = new RegExp('^' + opts.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const keys = [...r.dump.keys()].sort();
    const start = Number(cursor);
    const page = keys.slice(start, start + 2).filter((k) => re.test(k));
    return [start + 2 >= keys.length ? '0' : String(start + 2), page] as [string, string[]];
  });
  const redis = Object.assign(r, { scan }) as typeof r & BreakGlassRedis;
  return { r, redis, scan };
}

function seedRecord(over: Partial<Staff> = {}): Staff {
  return {
    username: SEED,
    name: 'Main Admin',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'H-leaked',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function lockOut(r: ReturnType<typeof fakeRedis>, username: string) {
  const guard = createStaffLoginGuard(r, { now: () => NOW });
  for (let i = 0; i < 12; i++) await guard.reserve(username, '203.0.113.5');
  for (let i = 0; i < 12; i++) await guard.reserve(username, '203.0.113.6');
  await r.set(staffLoginKeys.u(username, NOW - DAY), '30'); // yesterday's bucket
}

const baseOpts = {
  now: () => NOW,
  seedUsername: SEED,
  seedPassword: SEED_PW,
  hash: hashPassword,
};

describe('staff-break-glass', () => {
  it('parses flags; dry run is the default', () => {
    expect(parseBreakGlassArgs(['ops', '--clear-lockout'])).toMatchObject({ username: 'ops', clearLockout: true, apply: false });
    expect(parseBreakGlassArgs(['ops', '--clear-lockout', '--ip', '1.2.3.4', '--apply'])).toMatchObject({
      ip: '1.2.3.4',
      apply: true,
    });
    expect(parseBreakGlassArgs(['--restore-seed-password-from-env', SEED])).toMatchObject({
      username: SEED,
      restoreSeedPassword: true,
    });
    expect(() => parseBreakGlassArgs(['--clear-lockout'])).toThrow(/username/i);
    expect(() => parseBreakGlassArgs(['ops'])).toThrow(/nothing to do/i);
  });

  it('--clear-lockout dry run counts and deletes nothing', async () => {
    const { r, redis } = withScan();
    await lockOut(r, 'ops');
    const before = new Map(r.dump);
    const lines: string[] = [];
    const report = await runStaffBreakGlass(redis, { ...baseOpts, username: 'ops', clearLockout: true, apply: false }, (l) => lines.push(l));
    expect(report.uiKeys).toBe(2);
    expect(report.uKeys).toBe(2);
    expect(new Map(r.dump)).toEqual(before);
  });

  it('--clear-lockout --apply (SCAN) frees the username on every IP', async () => {
    const { r, redis, scan } = withScan();
    await lockOut(r, 'ops');
    await lockOut(r, 'someone-else');
    await runStaffBreakGlass(redis, { ...baseOpts, username: 'ops', clearLockout: true, apply: true }, () => {});
    expect(scan).toHaveBeenCalled();
    const guard = createStaffLoginGuard(r, { now: () => NOW });
    expect((await guard.reserve('ops', '203.0.113.5')).allowed).toBe(true);
    expect((await guard.reserve('ops', '203.0.113.6')).allowed).toBe(true);
    expect(r.dump.has(staffLoginKeys.u('ops', NOW - DAY))).toBe(false);
    // Another username's buckets are untouched.
    expect((await guard.reserve('someone-else', '203.0.113.5')).allowed).toBe(false);
  });

  it('--clear-lockout --ip rebuilds the ui key without a SCAN', async () => {
    const { r, redis, scan } = withScan();
    await lockOut(r, 'ops');
    await runStaffBreakGlass(redis, { ...baseOpts, username: 'ops', clearLockout: true, ip: '203.0.113.5', apply: true }, () => {});
    expect(scan).not.toHaveBeenCalled();
    const guard = createStaffLoginGuard(r, { now: () => NOW });
    expect((await guard.reserve('ops', '203.0.113.5')).allowed).toBe(true);
    expect((await guard.reserve('ops', '203.0.113.6')).allowed).toBe(false); // other IP left alone
  });

  it('--restore-seed-password-from-env: dry-run writes nothing; --apply → the env password logs in and sessions are revoked', async () => {
    const { r, redis } = withScan();
    const store = createAuthStore(r);
    await store.saveStaff(seedRecord());
    const token = await store.createSession(SEED);
    const lines: string[] = [];

    await runStaffBreakGlass(redis, { ...baseOpts, username: SEED, restoreSeedPassword: true, apply: false }, (l) => lines.push(l));
    expect((await store.getStaff(SEED))!.passwordHash).toBe('H-leaked');
    expect(await store.getSessionUser(token)).toBe(SEED);

    await runStaffBreakGlass(redis, { ...baseOpts, username: SEED, restoreSeedPassword: true, apply: true }, (l) => lines.push(l));
    const after = (await store.getStaff(SEED))!;
    expect(await verifyPassword(SEED_PW, after.passwordHash)).toBe(true);
    expect(after.role).toBe('admin');
    expect(await store.getSessionUser(token)).toBeNull();

    const out = lines.join('\n');
    for (const secret of [SEED, SEED_PW, 'H-leaked', after.passwordHash, '203.0.113']) {
      expect(out).not.toContain(secret);
    }
  });

  it('--restore-seed-password-from-env refuses any other username, a non-platform-admin record, or an empty env password', async () => {
    const { r, redis } = withScan();
    const store = createAuthStore(r);
    await store.saveStaff(seedRecord({ username: 'ops' }));
    await expect(
      runStaffBreakGlass(redis, { ...baseOpts, username: 'ops', restoreSeedPassword: true, apply: true }, () => {}),
    ).rejects.toThrow(/SEED_ADMIN_USERNAME/);

    await store.saveStaff(seedRecord({ partnerId: 'acme' }));
    await expect(
      runStaffBreakGlass(redis, { ...baseOpts, username: SEED, restoreSeedPassword: true, apply: true }, () => {}),
    ).rejects.toThrow(/platform admin/i);
    expect((await store.getStaff(SEED))!.passwordHash).toBe('H-leaked');

    await store.saveStaff(seedRecord());
    await expect(
      runStaffBreakGlass(redis, { ...baseOpts, seedPassword: '', username: SEED, restoreSeedPassword: true, apply: true }, () => {}),
    ).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('is not wired into package.json or CI', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).not.toContain('staff-break-glass');
    const wf = join(root, '.github', 'workflows');
    for (const f of readdirSync(wf)) expect(readFileSync(join(wf, f), 'utf8')).not.toContain('staff-break-glass');
  });
});
