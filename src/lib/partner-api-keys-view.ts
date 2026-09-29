import { keyModeFromId, scopesForMode, type ApiKeyMode, type ApiScope } from './partner-api-scopes';
import type { ApiKeyPublic } from './partner-api-key';

// partner-api-keys-view (UI redesign M3-14): the pure rules behind /partner/integrations/api-keys.
// Client-safe (no server imports). The actions and the page share these, so the form, the cap and
// the listing agree. Display never carries the hash or a plaintext: only the key id, mode, last 4,
// the mode's fixed scope set (partner-api-scopes.ts scopesForMode) and timestamps.

/** At most this many UNREVOKED keys per mode per partner (plan M3-14). */
export const MAX_KEYS_PER_MODE = 5;

/** The result of an issuing action. The plaintext exists ONLY here, in the one action response. */
export type KeyIssueResult = { ok: true; plaintext: string; last4: string; mode: ApiKeyMode } | { ok: false; error: string };

/** STRICT: exactly 'test' or 'live' (no trimming, no case folding). */
export function parseKeyMode(v: unknown): ApiKeyMode | null {
  return v === 'test' || v === 'live' ? v : null;
}

// pk_test_<id> / pk_live_<id> (fix 44) and the grandfathered bare pk_<id>; <id> is base64url
// (src/lib/id.ts newTransferId). Bounded before any DB call.
const ID_BODY = /^[A-Za-z0-9_-]{1,64}$/;

export function parseKeyId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 80 || !v.startsWith('pk_')) return null;
  const rest = v.startsWith('pk_test_') || v.startsWith('pk_live_') ? v.slice('pk_test_'.length) : v.slice('pk_'.length);
  return ID_BODY.test(rest) ? v : null;
}

export interface KeyRowView {
  keyId: string;
  mode: ApiKeyMode;
  last4: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  active: boolean;
}

export function keyRowsView(keys: readonly ApiKeyPublic[]): KeyRowView[] {
  return keys.map((k) => {
    const mode = keyModeFromId(k.keyId);
    const row: KeyRowView = { keyId: k.keyId, mode, last4: k.last4, scopes: scopesForMode(mode), createdAt: k.createdAt, active: !k.revokedAt };
    if (k.lastUsedAt) row.lastUsedAt = k.lastUsedAt;
    if (k.revokedAt) row.revokedAt = k.revokedAt;
    return row;
  });
}

/** Unrevoked keys of one mode (the cap counts these). */
export function activeCount(keys: readonly ApiKeyPublic[], mode: ApiKeyMode): number {
  return keys.filter((k) => !k.revokedAt && keyModeFromId(k.keyId) === mode).length;
}
