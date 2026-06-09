import { getDb, type DbOrTx } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import type { Store } from './store';
import type { Customer } from './types';

// customer-store — CUT OVER to Postgres (Stage 2a). Same module path + surface.
// PII (fullName/DOB/address/govId) is envelope-encrypted at rest and decrypted
// by default on read (sanctions screening needs fullName on the hot path);
// `email` passes through verbatim (it is ALREADY a field-crypto blob written by
// customer-auth-store). upsertOnFirstInbound keeps grandfathering + opt-in
// backfill + WL2 follow-the-number — with the grandfather check now an indexed
// MIN(created_at) via store.firstTransferAt instead of a full-ledger scan.
export type { Customer };

export function createCustomerStore(db: DbOrTx, store: Store) {
  return createCustomerRepo(db, (phone) => store.firstTransferAt(phone));
}

export type CustomerStore = ReturnType<typeof createCustomerStore>;

let cached: CustomerStore | null = null;

export function getCustomerStore(store: Store): CustomerStore {
  if (!cached) cached = createCustomerStore(getDb(), store);
  return cached;
}
