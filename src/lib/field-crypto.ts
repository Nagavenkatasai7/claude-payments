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
 * For the fields sealed here, a leaked Redis token or DB dump yields only
 * ciphertext + wrapped DEKs, which are useless without the master key.
 *
 * What is NOT sealed (Program-Fix 37, crypto-06; an honest claim): sender and
 * recipient phone numbers (they are the lookup keys), `recipient_name`, ticket
 * bodies, and 30-day chat history in Redis stay plaintext. So a dump is NOT
 * ciphertext-only. Encrypting those is deferred to Phase 3 (fixes 45/46).
 */

const VERSION = 'v1';
/** Program-Fix 46: the context-bound envelope. Read since 46A; written since 46B. */
const VERSION_V2 = 'v2';
/**
 * The one key id a v2 blob may carry today. It is a slot in the blob AND bound
 * into the AAD, so fix 45 (key ring / rotation) adds kids without a v3.
 */
export const FIELD_KID = 'k0';
const KNOWN_KIDS: ReadonlySet<string> = new Set([FIELD_KID]);
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
 * Decode the master key from its env representation: a 64-hex-char OR a
 * base64-encoded 32-byte key (or an already-decoded 32-byte Buffer). THE one
 * decoder — EnvKeyProvider and blind-index.ts both use it, so the accepted
 * shapes can never drift apart (the boot-assert incident: a second parser
 * with a narrower contract rejected the valid production key). Throws on
 * anything that does not decode to exactly 32 bytes.
 */
export function decodeMasterKey(raw: string | Buffer | undefined): Buffer {
  const value = raw ?? '';
  if (Buffer.isBuffer(value)) {
    if (value.length !== MASTER_KEY_BYTES) {
      throw new Error('FIELD_ENCRYPTION_KEY missing or not 32 bytes');
    }
    return value;
  }
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (value.length > 0) {
    try {
      key = Buffer.from(value, 'base64');
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== MASTER_KEY_BYTES) {
    throw new Error('FIELD_ENCRYPTION_KEY missing or not 32 bytes');
  }
  return key;
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
    return decodeMasterKey(this.rawKey);
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
 * Program-Fix 46: WHERE a sealed value lives — the table, the column and the
 * row's key parts (see `src/lib/crypto-context.ts`, the only place contexts are
 * built). A v2 blob binds it into the GCM AAD, so the blob opens only in the
 * exact (table, column, row) it was sealed for. `v1Exempt` is NOT part of the
 * AAD: it marks the two purposes that keep reading v1 forever (46B's reject-v1
 * switch honours it).
 */
export interface CryptoContext {
  table: string;
  column: string;
  row: readonly string[];
  v1Exempt?: boolean;
}

const IDENT = /^[a-z][a-z0-9_.]*$/;

/**
 * The exact AAD string for a context:
 *   `v2|<kid>|<table>|<column>|<encodeURIComponent(part) joined by '|'>`.
 * encodeURIComponent escapes '|', so part boundaries are unambiguous. PINNED by
 * tests (field-crypto.test.ts, crypto-context.test.ts): changing it orphans every
 * v2 row. Throws on an invalid context; only the v2 paths ever call it, so a v1
 * read never depends on a context being well-formed.
 */
export function aadFor(ctx: CryptoContext, kid: string = FIELD_KID): string {
  if (!ctx || typeof ctx !== 'object') throw new Error('field-crypto: invalid context');
  if (typeof ctx.table !== 'string' || !IDENT.test(ctx.table)) {
    throw new Error('field-crypto: invalid context table');
  }
  if (typeof ctx.column !== 'string' || !IDENT.test(ctx.column)) {
    throw new Error('field-crypto: invalid context column');
  }
  if (!Array.isArray(ctx.row) || ctx.row.some((part) => typeof part !== 'string')) {
    throw new Error('field-crypto: invalid context row');
  }
  if (!KNOWN_KIDS.has(kid)) throw new Error('field-crypto: unknown key id');
  // Row arity is fixed per (table, column) by crypto-context.ts, so the
  // escaped '|'-joined parts are unambiguous within a column.
  const row = ctx.row.map((part) => encodeURIComponent(part)).join('|');
  return [VERSION_V2, kid, ctx.table, ctx.column, row].join('|');
}

// Retired test seam (Program-Fix 46A → 46B). 46A used it to switch v2 writes on
// inside tests; since 46B v2 IS the default for every context-carrying write, so
// it is a deliberate NO-OP in both directions: an afterEach(false) must never
// bring the unbound v1 writer back. Kept (with its production refusal) only so
// existing tests compile; pinned by field-crypto.test.ts.
export function __setFieldCryptoWriteV2ForTests(on: boolean): void {
  if (on && process.env.NODE_ENV === 'production') {
    throw new Error('field-crypto: the v2 write seam is test-only');
  }
}

/** Reject lone UTF-16 surrogates (see encryptField). */
function utf8Plaintext(plaintext: string): Buffer {
  // Buffer.from(…,'utf8') silently replaces lone surrogates with U+FFFD, which
  // would break the decrypt(encrypt(x)) === x invariant. Round-tripping through
  // the buffer detects any such non-encodable input up front.
  const buf = Buffer.from(plaintext, 'utf8');
  if (buf.toString('utf8') !== plaintext) {
    throw new Error('field-crypto: plaintext contains lone surrogates (not valid UTF-8)');
  }
  return buf;
}

/**
 * Seal one value as a v2, context-bound blob:
 *   `v2.<kid>.<b64url(iv)>.<b64url(tag)>.<b64url(wrappedDek)>.<b64url(ct)>`
 * with AAD = aadFor(ctx, kid). Since 46B encryptField routes every
 * context-carrying write through it (the never-auto-run re-encrypt script calls
 * it directly).
 */
export function sealFieldV2(
  plaintext: string,
  provider: EncryptionKeyProvider,
  ctx: CryptoContext,
  kid: string = FIELD_KID,
): string {
  const aad = aadFor(ctx, kid); // validates the context before any key use
  const plaintextBuf = utf8Plaintext(plaintext);
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedDek = provider.wrapDataKey(dek);
  return [VERSION_V2, kid, b64url(iv), b64url(tag), b64url(wrappedDek), b64url(ct)].join('.');
}

/**
 * Encrypt one field value.
 *
 * With a storage `ctx` (Program-Fix 46B — every src/ call site passes one; the
 * AST guard tests/field-crypto-ctx-guard.test.ts fails otherwise) it writes the
 * context-bound v2 envelope via `sealFieldV2`:
 *   `v2.<kid>.<b64url(iv)>.<b64url(tag)>.<b64url(wrappedDek)>.<b64url(ct)>`
 * which opens only under that exact (table, column, row). Every serving build
 * since 46A reads it, so rolling back to 46A stays safe; a pre-46A build does
 * NOT (never roll production back below 46A).
 *
 * Without a ctx it still writes the legacy v1 envelope
 *   `v1.<b64url(iv)>.<b64url(tag)>.<b64url(wrappedDek)>.<b64url(ct)>`
 * (AAD = the literal version): there is nothing to bind it to. Only tests and
 * legacy fixtures do that.
 *
 * Two calls on the same plaintext produce DIFFERENT blobs (random DEK + IVs).
 */
export function encryptField(
  plaintext: string,
  provider: EncryptionKeyProvider = defaultProvider(),
  ctx?: CryptoContext,
): string {
  if (ctx) return sealFieldV2(plaintext, provider, ctx);
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintextBuf = utf8Plaintext(plaintext);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(VERSION)); // bind the version as AAD (anti-transplant)
  const ct = Buffer.concat([
    cipher.update(plaintextBuf),
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

/** Decode + length-check the shared iv/tag segments of a v1 or v2 blob. */
function ivAndTag(ivB64: string, tagB64: string): { iv: Buffer; tag: Buffer } {
  const iv = fromB64url(ivB64);
  const tag = fromB64url(tagB64);
  // A well-formed blob has a 12-byte IV and a 16-byte GCM tag. Reject a blob
  // whose IV/tag decode to the wrong length up front, with a clear error, rather
  // than letting createDecipheriv/setAuthTag throw something opaque.
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error('field-crypto: malformed blob (bad iv length)');
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error('field-crypto: malformed blob (bad tag length)');
  }
  return { iv, tag };
}

function openWith(
  provider: EncryptionKeyProvider,
  iv: Buffer,
  tag: Buffer,
  wrappedDek: Buffer,
  ct: Buffer,
  aad: Buffer,
): string {
  const dek = provider.unwrapDataKey(wrappedDek); // throws if master key mismatches
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(aad); // must match the AAD bound at encrypt
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * Decrypt a blob produced by `encryptField` / `sealFieldV2`. Branches on the
 * VERSION before counting segments:
 *  - `v1.` — 5 segments, AAD `'v1'`; `ctx` is never validated, so a legacy
 *    row opens exactly as it did before fix 46 — UNLESS the optional
 *    FIELD_CRYPTO_REJECT_V1 switch (46B, default off) is on and `ctx` is a
 *    storage context that is not permanently v1-exempt (`ctx.v1Exempt`:
 *    customer_ref, staff MFA). The switch is meant to be flipped only after the
 *    re-encrypt backfill has left no v1 rows; a ctx-less read is never refused
 *    (the AST guard keeps every src/ read context-carrying);
 *  - `v2.` — 6 segments, a known kid, and `ctx` is REQUIRED; AAD = aadFor(ctx,
 *    kid), so a blob opens only under the context it was sealed for.
 * Throws on format / unknown-version errors, a wrapped DEK that doesn't unwrap
 * under this provider's master key, and any GCM auth-tag failure. Error text
 * never contains the context (it holds row keys: phones, partner ids).
 */
export function decryptField(
  blob: string,
  provider: EncryptionKeyProvider = defaultProvider(),
  ctx?: CryptoContext,
): string {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('field-crypto: empty or non-string blob');
  }
  const parts = blob.split('.');
  if (parts[0] === VERSION_V2) {
    if (parts.length !== 6) {
      throw new Error('field-crypto: malformed blob');
    }
    const [, kid, ivB64, tagB64, wrappedB64, ctB64] = parts;
    if (!KNOWN_KIDS.has(kid)) {
      throw new Error('field-crypto: unknown key id');
    }
    if (!ctx) {
      throw new Error('field-crypto: a v2 blob needs its storage context');
    }
    const aad = Buffer.from(aadFor(ctx, kid), 'utf8');
    const { iv, tag } = ivAndTag(ivB64, tagB64);
    return openWith(provider, iv, tag, fromB64url(wrappedB64), fromB64url(ctB64), aad);
  }
  if (parts.length !== 5) {
    throw new Error('field-crypto: malformed blob');
  }
  const [version, ivB64, tagB64, wrappedB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`field-crypto: unsupported version "${version}"`);
  }
  if (ctx && ctx.v1Exempt !== true && env.fieldCryptoRejectV1) {
    // Program-Fix 46B: an unbound v1 blob could have been moved here from any
    // other column or row. Never echo the context (it holds row keys).
    throw new Error('field-crypto: v1 blob refused (FIELD_CRYPTO_REJECT_V1)');
  }
  const { iv, tag } = ivAndTag(ivB64, tagB64);
  return openWith(provider, iv, tag, fromB64url(wrappedB64), fromB64url(ctB64), Buffer.from(version));
}
