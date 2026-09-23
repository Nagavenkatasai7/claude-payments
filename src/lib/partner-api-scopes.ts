// partner-api-scopes — Program-Fix 44 P1. The ONE rule for a Partner API key's
// mode (live / test) and its scope set. Pure and client-safe: the dashboard
// imports keyModeFromId from here so every page displays a key's mode the same
// way.
//
// Mode is AUTHORITATIVELY derived from the authenticated plaintext's prefix
// (sr_live_ / sr_test_). The stored hash covers the whole plaintext, prefix
// included, so a caller cannot flip a key's mode by editing the prefix: the
// edited string hashes to no row. The key id mirrors the mode (pk_live_ /
// pk_test_) for display only; every pre-fix key id is a bare pk_<id>, which
// reads as live (grandfathered, owner decision A1).
//
// Scopes are FIXED per mode until sandbox isolation (P2) adds a per-key scopes
// column: live holds everything; test holds only the three read-only /
// stateless scopes, because without an environment column on transfers a test
// key could otherwise mint, confirm or read live money.

export type ApiKeyMode = 'live' | 'test';

export const ALL_SCOPES = [
  'corridors:read',
  'quote',
  'beneficiaries:validate',
  'beneficiaries:write',
  'transactions:read',
  'transactions:write',
  'rates:read',
  'rates:write',
  'settlements:read',
] as const;

export type ApiScope = (typeof ALL_SCOPES)[number];

const TEST_SCOPES: readonly ApiScope[] = ['corridors:read', 'quote', 'beneficiaries:validate'];

const PLAINTEXT_PREFIX: Record<ApiKeyMode, string> = {
  live: 'sr_live_',
  test: 'sr_test_',
};

/** Mode from a presented plaintext; null when it carries neither accepted prefix. */
export function keyModeFromPlaintext(plaintext: string): ApiKeyMode | null {
  if (typeof plaintext !== 'string') return null;
  if (plaintext.startsWith(PLAINTEXT_PREFIX.live)) return 'live';
  if (plaintext.startsWith(PLAINTEXT_PREFIX.test)) return 'test';
  return null;
}

/** THE display rule: pk_test_… is test; pk_live_… and every legacy pk_<id> is live. */
export function keyModeFromId(keyId: string): ApiKeyMode {
  return typeof keyId === 'string' && keyId.startsWith('pk_test_') ? 'test' : 'live';
}

/** The plaintext prefix a key of this mode carries (dashboard display). */
export function displayKeyPrefix(mode: ApiKeyMode): string {
  return PLAINTEXT_PREFIX[mode];
}

/** The fixed scope set for a mode (a fresh copy). */
export function scopesForMode(mode: ApiKeyMode): ApiScope[] {
  return mode === 'test' ? [...TEST_SCOPES] : [...ALL_SCOPES];
}

export function hasScope(scopes: readonly ApiScope[], scope: ApiScope): boolean {
  return scopes.includes(scope);
}
