import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { env } from '@/lib/env';

/**
 * field-crypto — AES-256-GCM **envelope** encryption for C2 PII fields.
 *
 * Why envelope (not "encrypt with one app key"): each value is sealed under its
 * own random 32-byte **data key (DEK)**; the DEK is itself sealed ("wrapped")
 * under a **master key** that an `EncryptionKeyProvider` controls. Only the
 * ciphertext + the wrapped DEK are ever stored — the plaintext DEK exists only
 * in memory for the duration of an encrypt/decrypt.
 *
 * **Crypto-shred:** because the (wrapped) DEK lives *inside* the stored blob,
 * deleting the stored blob destroys the only copy of that record's data key, so
 * the value becomes permanently undecryptable. Dropping the blob = secure
 * disposal (GLBA 16 CFR 314.4 / NIST 800-88), no key-rotation dance required.
 *
 * **KMS seam:** `EncryptionKeyProvider` mirrors how a real KMS wraps/unwraps a
 * data key *without ever exposing the master key to the app*. Today
 * `EnvKeyProvider` does the wrap/unwrap locally from an app-managed master key
 * (a Vercel secret). A real KMS upgrade swaps in a provider whose
 * wrap/unwrap call out to AWS/GCP KMS (master key in an HSM) — call sites
 * (`encryptField`/`decryptField`) never change.
 *
 * A leaked Redis token therefore yields only ciphertext + wrapped DEKs, which
 * are useless without the master key — keeping a dump out of the FTC
 * 30-day-notification + CCPA per-consumer-penalty triggers.
 */

const VERSION = 'v1';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32; // AES-256
const MASTER_KEY_BYTES = 32; // AES-256

/**
 * Wraps/unwraps a per-record data key (DEK) without exposing the master key —
 * the exact contract a real KMS (AWS/GCP) fulfils.
 */
export interface EncryptionKeyProvider {
  /** Seal a plaintext DEK; returns an opaque wrapped blob to store. */
  wrapDataKey(dek: Buffer): Buffer;
  /** Recover the plaintext DEK from a wrapped blob. */
  unwrapDataKey(wrapped: Buffer): Buffer;
}

/** AES-256-GCM(masterKey, random IV) over a buffer → iv||tag||ciphertext. */
function aesGcmSeal(masterKey: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Reverse aesGcmSeal; throws on auth-tag failure. */
function aesGcmOpen(masterKey: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('field-crypto: wrapped blob too short');
  }
  const iv = sealed.subarray(0, GCM_IV_BYTES);
  const tag = sealed.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ct = sealed.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * App-managed master key from a Vercel secret. Accepts a 64-hex-char OR a
 * base64-encoded 32-byte key; validates the **decoded** length is 32 bytes
 * **at use** (not at import) so dev/test without the env var doesn't break the
 * whole app — only crypto operations fail, loudly.
 */
export class EnvKeyProvider implements EncryptionKeyProvider {
  constructor(private readonly rawKey: string | Buffer) {}

  private masterKey(): Buffer {
    const raw = this.rawKey ?? '';
    if (Buffer.isBuffer(raw)) {
      if (raw.length !== MASTER_KEY_BYTES) {
        throw new Error('FIELD_ENCRYPTION_KEY missing or not 32 bytes');
      }
      return raw;
    }
    let key: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      key = Buffer.from(raw, 'hex');
    } else if (raw.length > 0) {
      try {
        key = Buffer.from(raw, 'base64');
      } catch {
        key = null;
      }
    }
    if (!key || key.length !== MASTER_KEY_BYTES) {
      throw new Error('FIELD_ENCRYPTION_KEY missing or not 32 bytes');
    }
    return key;
  }

  wrapDataKey(dek: Buffer): Buffer {
    return aesGcmSeal(this.masterKey(), dek);
  }

  unwrapDataKey(wrapped: Buffer): Buffer {
    return aesGcmOpen(this.masterKey(), wrapped);
  }
}

/**
 * Lazily build the default provider from env so callers can inject a fixed-key
 * provider in tests / a KMS provider in prod without import-time coupling.
 */
export function defaultProvider(): EncryptionKeyProvider {
  return new EnvKeyProvider(env.fieldEncryptionKey);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url'); // base64url, no padding
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Encrypt one field value. Returns a compact, self-describing string:
 *   `v1.<b64url(iv)>.<b64url(tag)>.<b64url(wrappedDek)>.<b64url(ct)>`
 * Two calls on the same plaintext produce DIFFERENT blobs (random DEK + IVs).
 */
export function encryptField(
  plaintext: string,
  provider: EncryptionKeyProvider = defaultProvider(),
): string {
  // Lone surrogates are not valid UTF-8; Buffer.from silently replaces them
  // with U+FFFD, breaking the decrypt(encrypt(x)) === x invariant.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(plaintext)) {
    throw new Error('field-crypto: plaintext contains lone surrogate — not encodable as UTF-8');
  }
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(VERSION)); // bind the version as AAD (anti-transplant)
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const wrappedDek = provider.wrapDataKey(dek);
  return [
    VERSION,
    b64url(iv),
    b64url(tag),
    b64url(wrappedDek),
    b64url(ct),
  ].join('.');
}

/**
 * Decrypt a blob produced by `encryptField`. Throws on:
 *  - format / unknown-version errors,
 *  - a wrapped DEK that doesn't unwrap under this provider's master key,
 *  - any GCM auth-tag failure (tampered iv/tag/ct/wrappedDek).
 */
export function decryptField(
  blob: string,
  provider: EncryptionKeyProvider = defaultProvider(),
): string {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('field-crypto: empty or non-string blob');
  }
  const parts = blob.split('.');
  if (parts.length !== 5) {
    throw new Error('field-crypto: malformed blob');
  }
  const [version, ivB64, tagB64, wrappedB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`field-crypto: unsupported version "${version}"`);
  }
  const iv = fromB64url(ivB64);
  const tag = fromB64url(tagB64);
  const wrappedDek = fromB64url(wrappedB64);
  const ct = fromB64url(ctB64);

  const dek = provider.unwrapDataKey(wrappedDek); // throws if master key mismatches
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(Buffer.from(version)); // must match the AAD bound at encrypt
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}
