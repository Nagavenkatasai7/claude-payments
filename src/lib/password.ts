import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { env } from './env';
import { logWarn } from './log';

// Argon2id parameters — OWASP ASVS v5 / NIST 800-63B AAL2 floor.
// Store the full PHC string; verify back-compat with the legacy scrypt path.
const ARGON2_PARAMS = { memorySize: 19456, iterations: 2, parallelism: 1 } as const;

/**
 * Apply the optional HMAC pepper pre-step. The pepper lives only in a Vercel
 * secret (never in Redis), so a DB leak alone can't be brute-forced. When the
 * pepper is unset we return the plaintext unchanged, which keeps existing staff
 * scrypt hashes (created before any pepper) verifying.
 *
 * ⚠️ OPERATIONAL INVARIANT — the pepper is UNVERSIONED. Set `PASSWORD_PEPPER`
 * ONCE before any customer registers, and NEVER rotate it without a forced
 * password-reset migration: rotating it makes every existing Argon2id hash fail
 * to verify (the legacy-scrypt fallthrough does NOT cover Argon2id), locking out
 * those accounts. (Safe today: no customer accounts exist yet.) A future
 * versioned-pepper scheme — store the pepper id alongside the hash — is the
 * planned upgrade if rotation is ever required.
 */
function applyPepper(plain: string): string {
  const pepper = env.passwordPepper;
  if (!pepper) return plain;
  return createHmac('sha256', pepper).update(plain).digest('hex');
}

export async function hashPassword(plain: string): Promise<string> {
  const pre = applyPepper(plain);
  return argon2id({
    password: pre,
    salt: randomBytes(16),
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySize,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  if (stored.startsWith('$argon2')) {
    const pre = applyPepper(plain);
    try {
      return await argon2Verify({ password: pre, hash: stored });
    } catch {
      // Malformed PHC string ⇒ treat as a non-match (never throw to the caller).
      return false;
    }
  }
  // Legacy path: `salt:hash` scrypt, kept byte-for-byte from the pre-migration
  // implementation so existing hashes still verify (no pepper — these predate it).
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(plain, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Fix 21 (F62 / CWE-208): one Argon2id hash per instance, of a random secret
// nobody knows, so a login for a MISSING account can pay the same verify as a
// login for a real one. Memoized as a promise so concurrent first callers on a
// cold instance share the single computation. The value is never stored,
// logged or compared against anything real; it only burns the same work.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString('hex')).catch((err) => {
      dummyHashPromise = null; // don't cache a failure
      throw err;
    });
  }
  return dummyHashPromise;
}

/**
 * Verify a password against a stored hash that MAY be absent (unknown
 * username / phone, or a record without a password). When `stored` is empty
 * the same Argon2id verify runs against the per-instance dummy hash and the
 * result is ALWAYS false, so a caller that returns one generic error cannot be
 * told apart by response time. With a real hash this is exactly verifyPassword.
 */
export async function verifyPasswordOrDummy(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) {
    try {
      await verifyPassword(plain, await dummyHash());
    } catch (err) {
      // Fail CLOSED. A broken WASM build (hashPassword rejecting) must not turn
      // a missing account into a 500 while a real account gets the generic
      // failure — that difference is itself an enumeration signal. The memo is
      // already cleared by dummyHash()'s catch, so the next call retries.
      // Fields never carry the plaintext or the stored hash.
      logWarn('password.dummy_hash_failed', err, { path: 'dummy' });
    }
    return false;
  }
  return verifyPassword(plain, stored);
}

/**
 * True when `stored` should be upgraded on the next successful login: either it
 * isn't an Argon2id PHC string at all (legacy scrypt), or its m/t/p parameters
 * are below our target floor. Lets callers lazy-rehash transparently.
 */
export function needsRehash(stored: string): boolean {
  if (!stored.startsWith('$argon2id$')) return true;
  const match = stored.match(/\$m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) return true;
  const [, m, t, p] = match.map(Number);
  return (
    m < ARGON2_PARAMS.memorySize ||
    t < ARGON2_PARAMS.iterations ||
    p < ARGON2_PARAMS.parallelism
  );
}
