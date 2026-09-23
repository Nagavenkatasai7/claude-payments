/**
 * Program-Fix 14 step 9: build the OFAC SDN snapshot the list screener reads
 * when SANCTIONS_LIST=ofac-sdn. NOT run by CI, and the output is NOT committed
 * by this PR (owner decision C1 picks between committing a snapshot and the
 * Postgres-backed list in PR C). It needs no secrets.
 *
 *   node_modules/.bin/tsx scripts/sanctions/build-ofac-snapshot.ts
 *
 * Fetches SDN.XML from OFAC's Sanctions List Service (with a User-Agent: SLS
 * answers 403 without one; the URL 302-redirects to a signed download), parses
 * it with the SAME parser the tests pin (src/lib/sanctions/ofac-sdn-loader.ts),
 * and writes { source, version, hash, entries } to
 * src/lib/sanctions/data/ofac-snapshot.json. Prints only counts, the version
 * and the hash, never a name.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fetchOfacSdn } from '@/lib/sanctions/ofac-sdn-loader';
import { OFAC_SNAPSHOT_RELATIVE_PATH } from '@/lib/providers/sanctions-provider';

async function main() {
  const list = await fetchOfacSdn();
  const out = join(process.cwd(), OFAC_SNAPSHOT_RELATIVE_PATH);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(list), 'utf8');
  const names = list.entries.reduce((n, e) => n + e.names.length, 0);
  console.log(`wrote ${OFAC_SNAPSHOT_RELATIVE_PATH}: source=${list.source} version=${list.version} entries=${list.entries.length} names=${names} hash=${list.hash}`);
}

main().catch((err: unknown) => {
  console.error('build-ofac-snapshot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
