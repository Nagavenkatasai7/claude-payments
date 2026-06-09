import { getDb, type DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { Partner, PartnerId } from './types';

// partner-store — CUT OVER to Postgres (Stage 2a). The module path, factory
// name, and function surface are unchanged so every consumer keeps importing
// exactly what it always did; only the persistence engine moved (partners are
// ledger-adjacent config — relational, FK-enforced, transactional).
export type { Partner, PartnerId };

export function createPartnerStore(db: DbOrTx) {
  return createPartnerRepo(db);
}

export type PartnerStore = ReturnType<typeof createPartnerStore>;

let cached: PartnerStore | null = null;

export function getPartnerStore(): PartnerStore {
  if (!cached) cached = createPartnerStore(getDb());
  return cached;
}
