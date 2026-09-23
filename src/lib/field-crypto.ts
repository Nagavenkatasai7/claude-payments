import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { env } from '@/lib/env';
import { isKid } from '@/lib/key-id';

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
 * bodies written BEFORE fix 45 P4 (new ones are sealed, see ticket-repo.ts),
 * ticket subjects, staff escalation reasons (message text and audit meta), and
 * 30-day chat history in Redis stay plaintext. So a dump is NOT
 * ciphertext-only. Phones and `recipient_name` are a follow-up fix (a blind
 * index); legacy ticket bodies have no backfill yet.
 */

const VERSION = 'v1';
/** Program-Fix 46: the context-bound envelope. Read since 46A; written since 46B. */
const VERSION_V2 = 'v2';
/**
 * The key id every write uses: k0 = FIELD_ENCRYPTION_KEY, always (set-once,
 * never rotated). It is a slot in the v2 blob AND bound into the AAD, so fix 45
 * (key ring) adds kids without a v3.
 */
export const FIELD_KID = 'k0';
// Program-Fix 45: the kid grammar (k0 … k999) lives in key-id.ts, shared with
// boot-assert so the two can never disagree. Checked before any key use or AAD
// build; anything else is an unknown key id.
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

const RING_ENV = 'FIELD_ENCRYPTION_PREVIOUS_KEYS';

/**
 * Program-Fix 45 P3: parse the optional `FIELD_ENCRYPTION_PREVIOUS_KEYS` value —
 * a comma list of `<kid>:<key>` entries, each key in the SAME shapes
 * FIELD_ENCRYPTION_KEY accepts (decodeMasterKey). Returns a Map (never a plain
 * object, so a kid can never resolve to a prototype property).
 *
 * Refuses (throws, naming only the env var — never an entry or a key): a
 * malformed entry, a kid outside KID_PATTERN, a duplicate kid, a key that is
 * not 32 bytes, and any `k0` entry — k0 is always FIELD_ENCRYPTION_KEY and can
 * never be shadowed. Empty / unset ⇒ an empty ring.
 */
export function parseKeyRingEntries(raw: string | undefined): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) throw new Error(`field-crypto: ${RING_ENV} has a malformed entry`);
    const kid = trimmed.slice(0, colon).trim();
    if (!isKid(kid)) throw new Error(`field-crypto: ${RING_ENV} has an invalid key id`);
    if (kid === FIELD_KID) {
      throw new Error(`field-crypto: ${RING_ENV} may not redefine k0 (it is FIELD_ENCRYPTION_KEY)`);
    }
    if (ring.has(kid)) throw new Error(`field-crypto: ${RING_ENV} repeats a key id`);
    let key: Buffer;
    try {
      key = decodeMasterKey(trimmed.slice(colon + 1).trim());
    } catch {
      // decodeMasterKey's message names FIELD_ENCRYPTION_KEY; say which env it is.
      throw new Error(`field-crypto: ${RING_ENV} has a key that is not 32 bytes`);
    }
    ring.set(kid, key);
  }
  return ring;
}

/**
 * A provider that also resolves OTHER key ids (a key ring). decryptField uses
 * `providerForKid` only for a v2 blob whose kid is not k0; k0 and every v1 blob
 * always go through the provider itself.
 */
export interface KeyRingProvider extends EncryptionKeyProvider {
  /** The provider for a non-k0 kid, or undefined when the ring lacks it. */
  providerForKid(kid: string): EncryptionKeyProvider | undefined;
}

function isKeyRingProvider(p: EncryptionKeyProvider): p is KeyRingProvider {
  return typeof (p as Partial<KeyRingProvider>).providerForKid === 'function';
}

/**
 * Program-Fix 45 P3: the env key ring — `{ k0: FIELD_ENCRYPTION_KEY,
 * …FIELD_ENCRYPTION_PREVIOUS_KEYS }`. As an EncryptionKeyProvider it IS the k0
 * EnvKeyProvider (wrap/unwrap under FIELD_ENCRYPTION_KEY, byte-for-byte as
 * before), so every write and every k0 / v1 read is unchanged. The extra
 * entries are parsed lazily, only when a non-k0 kid is looked up, so a
 * malformed optional env can never break a k0 read, a v1 read or a write.
 */
export class EnvKeyRing extends EnvKeyProvider implements KeyRingProvider {
  constructor(
    rawKey: string | Buffer,
    private readonly rawRing: string | undefined = '',
  ) {
    super(rawKey);
  }

  providerForKid(kid: string): EncryptionKeyProvider | undefined {
    if (!isKid(kid) || kid === FIELD_KID) return undefined;
    const key = parseKeyRingEntries(this.rawRing).get(kid);
    return key ? new EnvKeyProvider(key) : undefined;
  }
}

/**
 * Lazily build the default provider from env so callers can inject a fixed-key
 * provider in tests / a KMS provider in prod without import-time coupling.
 * Since fix 45 P3 it is the env key ring; with FIELD_ENCRYPTION_PREVIOUS_KEYS
 * unset (production) it is exactly the k0 EnvKeyProvider it was before.
 */
export function defaultProvider(): EncryptionKeyProvider {
  return new EnvKeyRing(env.fieldEncryptionKey, env.fieldEncryptionPreviousKeys);
}

const CURRENT_KID_ENV = 'FIELD_ENCRYPTION_CURRENT_KID';

/**
 * Program-Fix 45 P4: the kid new context-bound writes use —
 * FIELD_ENCRYPTION_CURRENT_KID, default k0 (production: unset, so k0 and every
 * write is byte-shaped as before). FAILS CLOSED: a kid outside KID_PATTERN, or
 * one the given provider's ring does not hold, refuses the write (never a
 * silent fallback to k0 or to a plain provider). Errors name only the env var.
 */
export function currentWriteKid(provider: EncryptionKeyProvider = defaultProvider()): string {
  const kid = env.fieldEncryptionCurrentKid;
  if (!isKid(kid)) throw new Error(`field-crypto: ${CURRENT_KID_ENV} is not a valid key id`);
  if (kid === FIELD_KID) return kid;
  const held = isKeyRingProvider(provider) ? provider.providerForKid(kid) : undefined;
  if (!held) throw new Error(`field-crypto: ${CURRENT_KID_ENV} names a key id the key ring does not hold`);
  return kid;
}

/**
 * The provider that unwraps a v2 blob of this kid. k0 → the given provider,
 * exactly as before fix 45. Any other kid → ONLY a ring-capable provider that
 * holds it; a plain (test / KMS) provider is never silently used for a non-k0
 * kid. No trial decryption: exactly one key is ever tried.
 */
function providerForBlobKid(provider: EncryptionKeyProvider, kid: string): EncryptionKeyProvider {
  if (!isKid(kid)) throw new Error('field-crypto: unknown key id');
  if (kid === FIELD_KID) return provider;
  const p = isKeyRingProvider(provider) ? provider.providerForKid(kid) : undefined;
  if (!p) throw new Error('field-crypto: unknown key id');
  return p;
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
  // Program-Fix 45 P3: the blob's own kid is bound (k1 … as well as k0). The
  // default stays k0, so every pinned `v2|k0|…` string is byte-identical.
  if (!isKid(kid)) throw new Error('field-crypto: unknown key id');
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
 * context-carrying write through it (the never-auto-run re-encrypt scripts call
 * it directly). Since fix 45 P4 the DEK is wrapped by the key of `kid` (k0 →
 * the provider; another kid → only a ring holding it, else it throws).
 */
export function sealFieldV2(
  plaintext: string,
  provider: EncryptionKeyProvider,
  ctx: CryptoContext,
  kid: string = FIELD_KID,
): string {
  // Program-Fix 45 P4: wrap the DEK with THIS kid's key, resolved exactly as
  // the reader resolves it (k0 → the provider itself; any other kid → only a
  // ring that holds it). Resolved before any randomness, so a kid nothing
  // could open is refused rather than written.
  const keyProvider = providerForBlobKid(provider, kid);
  const aad = aadFor(ctx, kid); // validates the context before any key use
  const plaintextBuf = utf8Plaintext(plaintext);
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedDek = keyProvider.wrapDataKey(dek);
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
 * The kid is the configured current kid (fix 45 P4, `currentWriteKid`):
 * FIELD_ENCRYPTION_CURRENT_KID, default k0 — unset in production, so every
 * production write stays `v2.k0.` under FIELD_ENCRYPTION_KEY. A current kid
 * that is malformed or missing from the key ring REFUSES the write.
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
  if (ctx) return sealFieldV2(plaintext, provider, ctx, currentWriteKid(provider));
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
 *  - `v2.` — 6 segments, a well-formed kid, and `ctx` is REQUIRED; AAD =
 *    aadFor(ctx, kid), so a blob opens only under the context it was sealed
 *    for. The wrapped DEK is unwrapped by the key of THAT kid (fix 45 P3): k0
 *    by the given provider, any other kid only by a KeyRingProvider holding
 *    it (defaultProvider() is the env ring). v1 always opens under k0.
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
    if (!isKid(kid)) {
      throw new Error('field-crypto: unknown key id');
    }
    if (!ctx) {
      throw new Error('field-crypto: a v2 blob needs its storage context');
    }
    const aad = Buffer.from(aadFor(ctx, kid), 'utf8');
    const { iv, tag } = ivAndTag(ivB64, tagB64);
    // Program-Fix 45 P3: unwrap with the ring key of the blob's own kid (bound
    // into the AAD above, so an edited kid fails the GCM tag).
    const keyProvider = providerForBlobKid(provider, kid);
    return openWith(keyProvider, iv, tag, fromB64url(wrappedB64), fromB64url(ctB64), aad);
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
