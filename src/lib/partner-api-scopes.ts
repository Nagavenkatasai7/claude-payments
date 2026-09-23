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
// Scopes are a per-mode CEILING: live holds everything; test holds the three
// read-only / stateless scopes plus, since sandbox isolation (P2: the
// transfers.environment column), transactions:read and transactions:write —
// a test key mints, confirms and reads ONLY sandbox transfers. It never holds
// rates, beneficiaries:write or settlements. P2's api_keys.scopes column can
// only NARROW a key below its mode's ceiling (effectiveScopes); NULL means
// the full mode set, so every existing key is unchanged.

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

const TEST_SCOPES: readonly ApiScope[] = [
  'corridors:read',
  'quote',
  'beneficiaries:validate',
  'transactions:read', // P2: sandbox transfers only (transfers.environment)
  'transactions:write', // P2: sandbox transfers only; always the mock rail
];

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

/**
 * THE scope rule for an authenticated key (Program-Fix 44 P2): the stored
 * api_keys.scopes value intersected with the mode's ceiling, in ALL_SCOPES
 * order. NULL / undefined ⇒ the mode set (every pre-P2 key). Fails CLOSED:
 * unknown entries are dropped and a non-array stored value grants nothing.
 */
export function effectiveScopes(mode: ApiKeyMode, stored: unknown): ApiScope[] {
  const ceiling = scopesForMode(mode);
  if (stored === null || stored === undefined) return ceiling;
  if (!Array.isArray(stored)) return [];
  const wanted = new Set(stored.filter((s): s is string => typeof s === 'string'));
  return ALL_SCOPES.filter((s) => wanted.has(s) && ceiling.includes(s));
}

export function hasScope(scopes: readonly ApiScope[], scope: ApiScope): boolean {
  return scopes.includes(scope);
}
