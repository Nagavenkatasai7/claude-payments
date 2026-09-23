/**
 * Program-Fix 14 PR C: ONE manual OFAC SDN list load into the database at
 * DATABASE_URL — the same code path the daily cron runs when
 * SANCTIONS_LOADER_ENABLED is set (src/lib/sanctions/list-loader.ts). NOT run
 * by CI. OWNER-ONLY against production: it writes a new list version, an
 * audit row and (on failure) an ops alert row.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/sanctions/load-ofac-sdn.ts
 *
 * Fetches SDN.XML from Treasury's Sanctions List Service with a User-Agent
 * (SLS answers 403 without one), parses it, and stores/activates it in one
 * transaction. Prints only the status, version, counts and hash — never a name.
 */
import { getDb } from '@/db/client';
import { runOfacSdnLoad } from '@/lib/sanctions/list-loader';

async function main() {
  const res = await runOfacSdnLoad({ db: getDb() });
  if (res.status === 'failed') {
    console.error(`load-ofac-sdn failed: reason=${res.reason} (the last good version, if any, stays active)`);
    process.exit(1);
  }
  console.log(
    `load-ofac-sdn: status=${res.status} version=${res.version} entries=${res.entryCount} names=${res.nameCount} hash=${res.hash}`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('load-ofac-sdn crashed:', err instanceof Error ? err.name : 'unknown');
  process.exit(1);
});
