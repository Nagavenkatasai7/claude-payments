import { createHmac, hkdfSync } from 'node:crypto';
import { decodeMasterKey } from '@/lib/field-crypto';
import { env } from '@/lib/env';

/**
 * blind-index — a KEYED, deterministic fingerprint of a PII value so a table
 * can enforce UNIQUE(email) / UNIQUE(phone) while the value itself is stored
 * only as a field-crypto ciphertext (which is randomised per write and so can
 * never be compared or indexed).
 *
 * Why keyed: an unkeyed SHA-256 of an email or phone is reversible by
 * dictionary — the input space is tiny. HMAC under a secret key turns the
 * column into ciphertext-grade data: a DB dump alone cannot be matched
 * against a list of known emails.
 *
 * DERIVATION (pinned by tests/blind-index.test.ts — changing it orphans every
 * stored index):
 *   masterKey = decodeMasterKey(FIELD_ENCRYPTION_KEY)      (hex64 | base64-32)
 *   K         = HKDF-SHA256(ikm = masterKey, salt = "", info = BLIND_INDEX_INFO, L = 32)
 *   index     = hex( HMAC-SHA256(K, `${purpose}:${normalizedValue}`) )
 *
 * The key is derived from FIELD_ENCRYPTION_KEY — the one set-once, never-rotate
 * secret (CLAUDE.md) — through HKDF with a purpose-specific `info`, so the
 * index key is cryptographically separated from the envelope-encryption master
 * key (a compromise of one HMAC key reveals nothing about the master) and the
 * master is never used directly as an HMAC key. PASSWORD_PEPPER is deliberately
 * NOT reused: one key, one purpose. Rotating FIELD_ENCRYPTION_KEY would orphan
 * every stored index (as it would every ciphertext) — that key does not rotate.
 *
 * The `purpose` prefix (e.g. 'email', 'phone') domain-separates columns: the
 * same string under two purposes yields two unrelated indexes. Callers pass the
 * NORMALISED value (lowercased email, E.164 phone) — normalisation is the
 * caller's contract, since the whole point is that variants collide.
 *
 * Node API: hkdfSync(digest, ikm, salt, info, keylen) → ArrayBuffer
 * (node_modules/@types/node/crypto.d.ts:3526-3532).
 */

export const BLIND_INDEX_INFO = 'smartremit/blind-index/v1';

/** Derive the 32-byte blind-index key. Throws when the master key is missing/malformed — never falls back to an unkeyed hash. */
export function deriveBlindIndexKey(masterRaw: string | Buffer = env.fieldEncryptionKey): Buffer {
  const master = decodeMasterKey(masterRaw);
  return Buffer.from(hkdfSync('sha256', master, '', BLIND_INDEX_INFO, 32));
}

let cachedKey: Buffer | null = null;
function defaultKey(): Buffer {
  if (!cachedKey) cachedKey = deriveBlindIndexKey();
  return cachedKey;
}

/** HMAC-SHA256(key, `${purpose}:${value}`) as 64 lowercase hex chars. */
export function blindIndex(purpose: string, normalizedValue: string, key: Buffer = defaultKey()): string {
  return createHmac('sha256', key).update(`${purpose}:${normalizedValue}`).digest('hex');
}
