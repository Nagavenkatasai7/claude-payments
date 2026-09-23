import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createStaffRepo } from '@/db/repos/staff-repo';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { runStaffBreakGlass, parseBreakGlassArgs, BreakGlassError, type BreakGlassRedis } from '../scripts/staff-break-glass';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffLoginGuard, staffLoginKeys } from '@/lib/staff-login-guard';
import { hashPassword, verifyPassword } from '@/lib/password';
import type { Staff } from '@/lib/types';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { base32Decode, totpAt } from '@/lib/totp';

/**
 * Program-Fix 17a — the owner-run break-glass script. Dry run by default
 * (counts only), `--apply` to write. Output never carries a username, an IP,
 * a hash or a password. `scan` is a stub paging the fake's keys like Upstash.
 */

const NOW = Date.UTC(2026, 8, 23, 10, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const SEED = 'owner-admin';
// Built, not a literal: a fake value that must never read as a credential to secret scanners.
const SEED_PW = 'x'.repeat(16) + '-fixture';

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
  // ── Program-Fix 17b: --clear-mfa (the owner's way back in after losing the device) ──
  it('parses --clear-mfa on its own', () => {
    expect(parseBreakGlassArgs([SEED, '--clear-mfa'])).toMatchObject({ username: SEED, clearMfa: true, apply: false });
  });

  it('--clear-mfa dry run counts and writes nothing; --apply turns MFA off; output never carries the username', async () => {
    const { r, redis } = withScan();
    await createAuthStore(r).saveStaff(seedRecord());
    const mfa = createStaffMfaStore(r, { now: () => NOW });
    const b = await mfa.beginEnrolment(SEED);
    if (!b.ok) throw new Error('enrol refused');
    expect(await mfa.confirmEnrolment(SEED, totpAt(base32Decode(b.secretBase32), NOW))).toBe('ok');

    const before = new Map(r.dump);
    const lines: string[] = [];
    const dry = await runStaffBreakGlass(redis, { ...baseOpts, username: SEED, clearMfa: true, apply: false }, (l) => lines.push(l));
    expect(dry.mfaKeys).toBeGreaterThanOrEqual(1);
    expect(r.dump).toEqual(before);
    expect(await mfa.isEnrolled(SEED)).toBe(true);

    const applied = await runStaffBreakGlass(redis, { ...baseOpts, username: SEED, clearMfa: true, apply: true }, (l) => lines.push(l));
    expect(applied.mfaKeys).toBe(dry.mfaKeys);
    expect(await mfa.isEnrolled(SEED)).toBe(false);
    expect(lines.join('\n')).not.toContain(SEED);
    expect(lines.join('\n')).not.toContain(b.secretBase32);
  });
});

// Program-Fix 45 P5: the staff ledger (Postgres `staff`, migration 0022). The
// break-glass keeps the seed admin reachable when the row and Redis disagree.
describe('staff-break-glass and the staff ledger (Program-Fix 45 P5)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('parses --sync-ledger-from-redis on its own', () => {
    expect(parseBreakGlassArgs([SEED, '--sync-ledger-from-redis'])).toMatchObject({ username: SEED, syncLedger: true, apply: false });
  });

  it('--restore-seed-password-from-env --apply also mirrors the new hash into the row', async () => {
    const { r, redis } = withScan();
    const repo = createStaffRepo(db);
    await createAuthStore(r, { ledger: () => repo, seedName: () => SEED }).saveStaff(seedRecord());
    await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, restoreSeedPassword: true, apply: true }, () => {});
    const row = (await repo.get(SEED))!;
    expect(await verifyPassword(SEED_PW, row.passwordHash)).toBe(true);
  });

  it('--sync-ledger-from-redis: dry run reports and writes nothing; --apply rewrites the row from the Redis record', async () => {
    const { r, redis } = withScan();
    const repo = createStaffRepo(db);
    await createAuthStore(r).saveStaff(seedRecord());
    await repo.upsert(seedRecord({ status: 'suspended', role: 'support', passwordHash: 'stale' }));
    const lines: string[] = [];

    const dry = await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, syncLedger: true }, (l) => lines.push(l));
    expect(dry.ledgerRow).toBe('differs');
    expect(dry.ledgerSynced).toBe(false);
    expect((await repo.get(SEED))!.status).toBe('suspended');

    const applied = await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, syncLedger: true, apply: true }, (l) => lines.push(l));
    expect(applied.ledgerSynced).toBe(true);
    const row = (await repo.get(SEED))!;
    expect(row.status).toBe('active');
    expect(row.role).toBe('admin');
    expect(row.passwordHash).toBe('H-leaked');

    const again = await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, syncLedger: true }, () => {});
    expect(again.ledgerRow).toBe('match');

    const out = lines.join('\n');
    for (const secret of [SEED, 'H-leaked', 'stale']) expect(out).not.toContain(secret);
  });

  it('--sync-ledger-from-redis creates a missing row, and refuses without a Redis record or without a database', async () => {
    const { r, redis } = withScan();
    const repo = createStaffRepo(db);
    await createAuthStore(r).saveStaff(seedRecord());
    const rep = await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, syncLedger: true, apply: true }, () => {});
    expect(rep.ledgerRow).toBe('missing');
    expect((await repo.get(SEED))?.role).toBe('admin');

    await expect(
      runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: 'nobody', syncLedger: true, apply: true }, () => {}),
    ).rejects.toThrow(/no Redis record/i);
    await expect(
      runStaffBreakGlass(redis, { ...baseOpts, username: SEED, syncLedger: true, apply: true }, () => {}),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('--sync-ledger-from-redis: a database refusal never carries the hash or username', async () => {
    const { r, redis } = withScan();
    const repo = createStaffRepo(db);
    // partner p_missing does not exist → the FK refuses → DrizzleQueryError with params.
    await createAuthStore(r).saveStaff(seedRecord({ partnerId: 'p_missing', passwordHash: 'SECRET-HASH-FIXTURE' }));
    const err = await runStaffBreakGlass(redis, { ...baseOpts, ledger: repo, username: SEED, syncLedger: true, apply: true }, () => {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(BreakGlassError);
    expect(String(err!.message)).not.toContain('SECRET-HASH');
    expect(String(err!.message)).not.toContain(SEED);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
