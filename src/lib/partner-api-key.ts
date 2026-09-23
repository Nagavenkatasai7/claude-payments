import { getDb, type DbOrTx } from '@/db/client';
import { createApiKeyRepo, type ApiKeyRepoDeps } from '@/db/repos/api-key-repo';
import { getRedis } from './redis';
import type { PartnerId } from './types';

// partner-api-key — CUT OVER to Postgres (Stage 2a). Same surface (issue /
// authenticate / revoke / list) and the same security contract: plaintext
// shown ONCE at issue; only the SHA-256(+pepper) hash at rest (UNIQUE index =
// O(1) auth lookup); partnerId is bound to the key row — the SOLE source of a
// request's tenant, never the request body.

export interface ApiKeyRecord {
  partnerId: PartnerId;
  keyId: string;
  createdAt: string;
  revokedAt?: string;
}

/** Public, listable view — never exposes the hash or the plaintext. */
export interface ApiKeyPublic {
  keyId: string;
  createdAt: string;
  revokedAt?: string;
  last4: string;
  /** Last authenticated use (throttled to ~5 min granularity). Absent ⇒ never used since fix 44. */
  lastUsedAt?: string;
}

export interface IssuedApiKey {
  plaintext: string; // shown ONCE; never persisted
  keyId: string;
  last4: string;
}

export type PartnerApiKeyDeps = ApiKeyRepoDeps;

export function createPartnerApiKeyStore(db: DbOrTx, deps: PartnerApiKeyDeps = {}) {
  return createApiKeyRepo(db, deps);
}

export type PartnerApiKeyStore = ReturnType<typeof createPartnerApiKeyStore>;

let cached: PartnerApiKeyStore | null = null;

export function getPartnerApiKeyStore(): PartnerApiKeyStore {
  // Redis carries the last_used_at throttle marker (fix 44); wired only here so
  // test-built stores never construct a real Upstash client.
  if (!cached) cached = createPartnerApiKeyStore(getDb(), { redis: getRedis() });
  return cached;
}
