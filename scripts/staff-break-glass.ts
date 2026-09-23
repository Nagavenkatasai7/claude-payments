/**
 * OWNER-RUN break-glass for staff sign-in (Program-Fix 17a). Never wired into
 * package.json or CI. DRY RUN by default: prints COUNTS only. It never prints
 * a username, an IP, a key name, a hash or a password.
 *
 *   set -a; source .env.local; set +a
 *   node_modules/.bin/tsx scripts/staff-break-glass.ts <username> --clear-lockout [--ip <ip>] [--apply]
 *   node_modules/.bin/tsx scripts/staff-break-glass.ts <username> --restore-seed-password-from-env [--apply]
 *   node_modules/.bin/tsx scripts/staff-break-glass.ts <username> --clear-mfa [--apply]
 *
 * --clear-lockout   DELs the username's all-IP day buckets (today + yesterday)
 *                   and its per-(username, IP) hour buckets: rebuilt for the
 *                   current and previous hour when --ip is given, otherwise
 *                   found by SCAN on the username's `ui` prefix. Key builders
 *                   are imported from src/lib/staff-login-guard.ts, so they
 *                   can never drift from the login's keys.
 * --restore-seed-password-from-env
 *                   Only for SEED_ADMIN_USERNAME, and only when that record
 *                   is a platform admin (role admin, no partnerId). Rewrites
 *                   its hash from SEED_ADMIN_PASSWORD and revokes its
 *                   sessions. Needed because seed.ts seeds only when there are
 *                   zero staff, so rotating the env var alone changes nothing.
 * --clear-mfa       Program-Fix 17b: turns the username's TOTP MFA off (its
 *                   sealed secret, any pending enrolment and the replay
 *                   marker), so the password alone signs in again. The
 *                   owner's way back in when the seed admin's authenticator is
 *                   lost and no other platform admin can reset it from the
 *                   Team page. Key builders come from src/lib/staff-mfa-store.ts.
 * --apply           Actually write. Without it nothing is changed.
 *
 * Upstash `scan(cursor, { match, count })` returns `[nextCursor, keys]` with a
 * STRING cursor; the loop ends at '0' (@upstash/redis 1.38.1
 * error-8y4qG0W2.d.ts:1487-1507 options, :4603-4605 signature). RedisLike
 * does not declare `scan`, so the script widens the shared client's type
 * locally instead of touching the interface (same as purge-legacy-session-keys.ts).
 */
import { getRedis } from '@/lib/redis';
import { createAuthStore } from '@/lib/auth-store';
import { hashPassword } from '@/lib/password';
import { isSeedAdminRecord, staffLoginKeys } from '@/lib/staff-login-guard';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import type { RedisLike } from '@/lib/store';

/** A refusal written by this script (safe to print: no names, no secrets). */
export class BreakGlassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreakGlassError';
  }
}

export interface BreakGlassRedis extends RedisLike {
  scan(cursor: string | number, opts: { match: string; count?: number }): Promise<[string | number, string[]]>;
}

export interface BreakGlassArgs {
  username: string;
  clearLockout: boolean;
  ip?: string;
  restoreSeedPassword: boolean;
  clearMfa: boolean;
  apply: boolean;
}

export interface BreakGlassOptions extends Partial<BreakGlassArgs> {
  username: string;
  now: () => number;
  seedUsername: string;
  seedPassword: string;
  hash: (password: string) => Promise<string>;
}

export interface BreakGlassReport {
  uiKeys: number;
  uKeys: number;
  sessionsRevoked: number;
  seedPasswordRestored: boolean;
  mfaKeys: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function parseBreakGlassArgs(argv: string[]): BreakGlassArgs {
  const out: BreakGlassArgs = {
    username: '',
    clearLockout: false,
    restoreSeedPassword: false,
    clearMfa: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clear-lockout') out.clearLockout = true;
    else if (a === '--restore-seed-password-from-env') out.restoreSeedPassword = true;
    else if (a === '--clear-mfa') out.clearMfa = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--ip') out.ip = argv[++i];
    else if (a.startsWith('--')) throw new BreakGlassError(`Unknown flag: ${a}`);
    else if (!out.username) out.username = a;
    else throw new BreakGlassError('Pass exactly one username.');
  }
  if (!out.username) throw new BreakGlassError('Pass the staff username as the first argument.');
  if (!out.clearLockout && !out.restoreSeedPassword && !out.clearMfa) {
    throw new BreakGlassError(
      'Nothing to do: pass --clear-lockout, --restore-seed-password-from-env and/or --clear-mfa.',
    );
  }
  if (out.ip !== undefined && !out.ip) throw new BreakGlassError('--ip needs a value.');
  return out;
}

async function scanAll(redis: BreakGlassRedis, match: string): Promise<string[]> {
  const seen = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 500 });
    for (const k of keys) seen.add(k);
    cursor = String(next);
  } while (cursor !== '0');
  return [...seen];
}

async function existing(redis: RedisLike, keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const k of keys) if (await redis.exists(k)) out.push(k);
  return out;
}

export async function runStaffBreakGlass(
  redis: BreakGlassRedis,
  opts: BreakGlassOptions,
  log: (line: string) => void,
): Promise<BreakGlassReport> {
  const t = opts.now();
  const mode = opts.apply ? 'APPLY' : 'DRY RUN';
  const report: BreakGlassReport = {
    uiKeys: 0,
    uKeys: 0,
    sessionsRevoked: 0,
    seedPasswordRestored: false,
    mfaKeys: 0,
  };

  if (opts.restoreSeedPassword) {
    // Validate BEFORE any write, including the lockout clear below.
    if (!opts.seedUsername || opts.username !== opts.seedUsername) {
      throw new BreakGlassError('--restore-seed-password-from-env only applies to SEED_ADMIN_USERNAME.');
    }
    if (!opts.seedPassword) throw new BreakGlassError('SEED_ADMIN_PASSWORD is empty; source the env first.');
  }

  if (opts.clearLockout) {
    const uKeys = await existing(redis, [
      staffLoginKeys.u(opts.username, t),
      staffLoginKeys.u(opts.username, t - DAY_MS),
    ]);
    const uiKeys = opts.ip
      ? await existing(redis, [
          staffLoginKeys.ui(opts.username, opts.ip, t),
          staffLoginKeys.ui(opts.username, opts.ip, t - HOUR_MS),
        ])
      : await scanAll(redis, `${staffLoginKeys.uiPrefix(opts.username)}*`);
    report.uKeys = uKeys.length;
    report.uiKeys = uiKeys.length;
    if (opts.apply) for (const k of [...uKeys, ...uiKeys]) await redis.del(k);
    log(`  lockout: ${uKeys.length} day bucket(s), ${uiKeys.length} per-IP bucket(s) ${opts.apply ? 'DELETED' : 'found (dry run)'}`);
  }

  if (opts.restoreSeedPassword) {
    const store = createAuthStore(redis);
    const record = await store.getStaff(opts.username);
    if (!record || !isSeedAdminRecord(record, opts.seedUsername)) {
      throw new BreakGlassError('The seed record is missing or is not a platform admin; refusing.');
    }
    const sessions = (await redis.smembers(`staff_sess_ix:${opts.username}`)).length;
    report.sessionsRevoked = sessions;
    if (opts.apply) {
      const newHash = await opts.hash(opts.seedPassword);
      const wrote = await store.setPasswordHash(opts.username, record.passwordHash, newHash);
      if (!wrote) throw new BreakGlassError('The record changed while running; re-run.');
      await store.deleteAllSessionsFor(opts.username);
      report.seedPasswordRestored = true;
    }
    log(`  seed password: ${opts.apply ? 'restored from env' : 'would be restored from env'}; ${sessions} session(s) ${opts.apply ? 'revoked' : 'would be revoked'}`);
  }

  if (opts.clearMfa) {
    const mfaKeys = await existing(redis, staffMfaKeys.perUser(opts.username));
    report.mfaKeys = mfaKeys.length;
    if (opts.apply) for (const k of mfaKeys) await redis.del(k);
    log(`  mfa: ${mfaKeys.length} key(s) ${opts.apply ? 'DELETED (MFA off; the password alone signs in)' : 'found (dry run)'}`);
  }

  log(`  mode: ${mode}`);
  return report;
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('KV_REST_API_URL / KV_REST_API_TOKEN not set — source .env.local first.');
    process.exit(1);
  }
  const args = parseBreakGlassArgs(process.argv.slice(2));
  console.log(`\nStaff break-glass (fix 17) — ${new Date().toISOString()} — ${args.apply ? 'APPLY' : 'DRY RUN'}`);
  await runStaffBreakGlass(
    getRedis() as unknown as BreakGlassRedis,
    {
      ...args,
      now: () => Date.now(),
      seedUsername: (process.env.SEED_ADMIN_USERNAME ?? '').trim(),
      seedPassword: process.env.SEED_ADMIN_PASSWORD ?? '',
      hash: hashPassword,
    },
    (line) => console.log(line),
  );
}

if (process.argv[1]?.endsWith('staff-break-glass.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      // Our own refusals print their message (no names, no secrets); any other
      // error prints its name only (a client error could echo a key).
      console.error(
        'staff-break-glass failed:',
        e instanceof BreakGlassError ? e.message : e instanceof Error ? e.name : 'unknown error',
      );
      process.exit(1);
    });
}
