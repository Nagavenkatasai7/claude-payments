/**
 * ONE-OFF owner-run sweep (Program-Fix 20): delete the pre-fix PLAINTEXT session
 * keys from Redis. After fix 20 no code path ever reads them for auth, but until
 * they are gone a Redis read still exposes raw bearer tokens.
 *
 * DRY RUN by default: it SCANs and prints COUNTS only. It never prints a key
 * name or a value (the key names ARE the tokens).
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/purge-legacy-session-keys.ts --staff
 *   … scripts/purge-legacy-session-keys.ts --staff --delete
 *
 * --staff    `session:*` (token → username) and `staff_sessions:*` (raw-token index).
 *            Run once the fix-20 deploy is at 100% (smoke green): every staff
 *            member has re-signed-in under `staff_sess:<sha256>` by then.
 * --customer `sr_sess_idx:*` (the raw-token revoke index) ONLY. The session
 *            records `sr_sess:<sha256>` are already hashed and are NEVER touched.
 *            Run at least 12 h after the deploy (the customer absolute session
 *            limit), when every session a legacy index points at has expired.
 *
 * Upstash `scan(cursor, { match, count })` returns `[nextCursor, keys]` with a
 * STRING cursor; the loop ends when it is '0' (@upstash/redis 1.38.1
 * error-8y4qG0W2.d.ts:1487-1507 options, :4603-4605 signature;
 * https://redis.io/commands/scan). SCAN may return a key more than once, so
 * keys are de-duplicated before counting or deleting.
 */
import { getRedis } from '@/lib/redis';

export interface PurgeRedis {
  scan(cursor: string | number, opts: { match: string; count?: number }): Promise<[string | number, string[]]>;
  del(key: string): Promise<unknown>;
}

export interface PurgeOptions {
  staff: boolean;
  customer: boolean;
  /** false (default) = count only. */
  del: boolean;
}

export const STAFF_PATTERNS = ['session:*', 'staff_sessions:*'] as const;
export const CUSTOMER_PATTERNS = ['sr_sess_idx:*'] as const;

async function scanAll(redis: PurgeRedis, match: string): Promise<string[]> {
  const seen = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 500 });
    for (const k of keys) seen.add(k);
    cursor = String(next);
  } while (cursor !== '0');
  return [...seen];
}

/** Returns { pattern → matched key count }. Deletes only with `del: true`. */
export async function purgeLegacySessionKeys(
  redis: PurgeRedis,
  opts: PurgeOptions,
  log: (line: string) => void,
): Promise<Record<string, number>> {
  const patterns = [
    ...(opts.staff ? STAFF_PATTERNS : []),
    ...(opts.customer ? CUSTOMER_PATTERNS : []),
  ];
  const report: Record<string, number> = {};
  for (const match of patterns) {
    const keys = await scanAll(redis, match);
    report[match] = keys.length;
    if (opts.del) {
      for (const k of keys) await redis.del(k);
      log(`  ${match}: ${keys.length} key(s) DELETED`);
    } else {
      log(`  ${match}: ${keys.length} key(s) found (dry run, nothing deleted)`);
    }
  }
  return report;
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('KV_REST_API_URL / KV_REST_API_TOKEN not set — source .env.local first.');
    process.exit(1);
  }
  const staff = process.argv.includes('--staff');
  const customer = process.argv.includes('--customer');
  const del = process.argv.includes('--delete');
  if (!staff && !customer) {
    console.error('Pass --staff and/or --customer (add --delete to remove; the default is a dry run).');
    process.exit(1);
  }
  const host = (() => { try { return new URL(process.env.KV_REST_API_URL ?? '').host; } catch { return '?'; } })();
  console.log(`\nLegacy session-key purge (fix 20) against ${host} — ${new Date().toISOString()} — ${del ? 'DELETE' : 'DRY RUN'}`);
  // getRedis() is the Upstash client; RedisLike just doesn't declare `scan`.
  const report = await purgeLegacySessionKeys(
    getRedis() as unknown as PurgeRedis,
    { staff, customer, del },
    (line) => console.log(line),
  );
  const total = Object.values(report).reduce((a, b) => a + b, 0);
  console.log(`\nSUMMARY: ${total} legacy key(s) ${del ? 'deleted' : 'found'}.\n`);
}

if (process.argv[1]?.endsWith('purge-legacy-session-keys.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      // Error name only: never echo a message that could carry a key.
      console.error('purge-legacy-session-keys failed:', e instanceof Error ? e.name : 'unknown error');
      process.exit(1);
    });
}
