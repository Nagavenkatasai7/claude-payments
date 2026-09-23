import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { PostgresSanctionsListSource } from '@/lib/sanctions/pg-list-source';
import { setOfacListSourceForTests } from '@/lib/providers/sanctions-provider';
import type { ActiveSanctionsVersion } from '@/db/repos/sanctions-list-repo';
import type { SanctionsList } from '@/lib/sanctions/list-source';

// Program-Fix 14 PR C: an OFAC source whose cache holds v1 while v2 (with
// newly listed names) is the ACTIVE version — only a warmSanctionsList() call
// before the screen can pick v2 up. ttlMs 0 ⇒ every warm() re-checks.
export const NEWLY_LISTED_PERSON = 'Newly Listed Person';
export const NEWLY_LISTED_BUSINESS = 'Newly Listed Trading LLC';

export async function primeStaleOfacSource(): Promise<void> {
  const v1: SanctionsList = parseOfacSdnXml(
    readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'),
  );
  const v2: SanctionsList = {
    ...v1,
    version: '2026-09-22',
    hash: 'c'.repeat(64),
    entries: [
      ...v1.entries,
      { id: 'sdn:2001', names: [NEWLY_LISTED_PERSON], type: 'Individual', programs: ['SDGT'] },
      { id: 'sdn:2002', names: [NEWLY_LISTED_BUSINESS], type: 'Entity', programs: ['SDGT'] },
    ],
  };
  const V1: ActiveSanctionsVersion = { id: 1, source: 'ofac-sdn', version: v1.version, hash: v1.hash, entryCount: v1.entries.length };
  const V2: ActiveSanctionsVersion = { id: 2, source: 'ofac-sdn', version: v2.version, hash: v2.hash, entryCount: v2.entries.length };
  const state = { active: V1 };
  const src = new PostgresSanctionsListSource(
    () => ({ activeVersion: async () => state.active, loadList: async (v) => (v.id === 1 ? v1 : v2) }),
    { ttlMs: 0 },
  );
  await src.load(); // v1 cached
  state.active = V2; // v2 activated after the TTL
  process.env.SANCTIONS_LIST = 'ofac-sdn';
  setOfacListSourceForTests(src);
}

export function restoreOfacSource(original: string | undefined): void {
  if (original === undefined) delete process.env.SANCTIONS_LIST;
  else process.env.SANCTIONS_LIST = original;
  setOfacListSourceForTests(null);
}
