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
 * planned upgrade if rotation is ever required. Program-Fix 45 ships it:
 * P3 the `$pv=<id>$` reader (below), P4 the writer (hashPassword tags p0).
 */
function applyPepper(plain: string, pepper: string = env.passwordPepper): string {
  if (!pepper) return plain;
  return createHmac('sha256', pepper).update(plain).digest('hex');
}

// ── Program-Fix 45 P3: the pepper-id READER ─────────────────────────────────
// A stored hash may carry the id of the pepper it was made under:
//   `$pv=<id>$<argon2 PHC>`   e.g. `$pv=p0$$argon2id$v=19$m=…`
// p0 is always PASSWORD_PEPPER (set-once, never rotated); other ids come only
// from the optional PASSWORD_PEPPER_PREVIOUS (`<id>:<pepper>` comma list,
// unset in production). Since P4, hashPassword writes `$pv=p0$<PHC>`; a bare
// `$argon2id$…` (written before P4) is an implicit p0 and is re-tagged once
// at the next successful login (needsRehash).
// API-key hashes (api-key-repo.ts) are deliberately NOT versioned.

/** The id of PASSWORD_PEPPER. Pinned by tests/password-pepper-id.test.ts. */
export const PEPPER_ID_CURRENT = 'p0';
const PEPPER_ID_PATTERN = /^p(?:0|[1-9][0-9]{0,2})$/;
const PV_PREFIX = /^\$pv=([^$]*)\$/;

/**
 * Split `$pv=<id>$<phc>`. Returns null for a stored value with no `$pv=`
 * prefix; `{ id: null }` for a prefix that is malformed or wraps anything but
 * an Argon2 PHC string — never the unpeppered legacy scrypt form, which would
 * be a downgrade.
 */
function splitPepperId(stored: string): { id: string | null; phc: string } | null {
  if (!stored.startsWith('$pv=')) return null;
  const m = PV_PREFIX.exec(stored);
  if (!m || !PEPPER_ID_PATTERN.test(m[1])) return { id: null, phc: '' };
  const phc = stored.slice(m[0].length);
  if (!phc.startsWith('$argon2')) return { id: null, phc: '' };
  return { id: m[1], phc };
}

/**
 * The pepper for an id: p0 → PASSWORD_PEPPER; any other id → its entry in
 * PASSWORD_PEPPER_PREVIOUS (parsed per call into a Map; a `p0` entry makes
 * the env malformed, so it can never shadow PASSWORD_PEPPER). Undefined when unknown or
 * when the optional env is malformed (logged without any value).
 */
function pepperForId(id: string): string | undefined {
  if (id === PEPPER_ID_CURRENT) return env.passwordPepper;
  const peppers = new Map<string, string>();
  for (const entry of env.passwordPepperPrevious.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    const entryId = colon > 0 ? trimmed.slice(0, colon).trim() : '';
    const pepper = colon > 0 ? trimmed.slice(colon + 1).trim() : '';
    if (
      !PEPPER_ID_PATTERN.test(entryId) ||
      entryId === PEPPER_ID_CURRENT || // p0 is PASSWORD_PEPPER; refused, as the field ring refuses k0
      pepper === '' ||
      peppers.has(entryId)
    ) {
      logWarn('password.pepper_previous_malformed', 'PASSWORD_PEPPER_PREVIOUS is malformed');
      return undefined;
    }
    peppers.set(entryId, pepper);
  }
  return peppers.get(id);
}

/**
 * Hash a new password. Program-Fix 45 P4: the result is tagged with the id of
 * the pepper it was made under — `$pv=p0$<argon2id PHC>` — so a future pepper
 * change can tell hashes apart. The PHC inside is byte-for-byte what was
 * written before. ⚠ Never roll production back below fix 45 P3: an older
 * verifyPassword rejects the `$pv=` form and would lock these accounts out.
 */
export async function hashPassword(plain: string): Promise<string> {
  const pre = applyPepper(plain);
  const phc = await argon2id({
    password: pre,
    salt: randomBytes(16),
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySize,
    hashLength: 32,
    outputType: 'encoded',
  });
  return `$pv=${PEPPER_ID_CURRENT}$${phc}`;
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const versioned = splitPepperId(stored);
  if (versioned) {
    const pepper = versioned.id === null ? undefined : pepperForId(versioned.id);
    if (pepper === undefined) {
      // A malformed prefix or an unknown pepper id: false, never a throw and
      // never another pepper. Burn the same Argon2 work as a real verify so
      // this account is not told apart by response time (fix 21).
      await burnDummyVerify(plain);
      return false;
    }
    try {
      return await argon2Verify({ password: applyPepper(plain, pepper), hash: versioned.phc });
    } catch {
      return false;
    }
  }
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

/** One Argon2 verify against the dummy hash; the result is discarded. */
async function burnDummyVerify(plain: string): Promise<void> {
  try {
    // Program-Fix 45 P4: the dummy is `$pv=p0$<PHC>`; hand argon2Verify the
    // bare PHC, or it rejects at parse time and burns no work (timing oracle).
    const dummy = await dummyHash();
    const hash = splitPepperId(dummy)?.phc || dummy;
    await argon2Verify({ password: applyPepper(plain), hash });
  } catch (err) {
    logWarn('password.dummy_hash_failed', err, { path: 'dummy' });
  }
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
  // Program-Fix 45: strip `$pv=<id>$` first. A malformed prefix or a
  // non-current pepper id → rehash (moves the hash onto PASSWORD_PEPPER).
  // P4: an UNTAGGED hash (legacy scrypt, or a bare `$argon2…` written before
  // P4) → rehash once; hashPassword then writes `$pv=p0$…`, which (at target
  // params) never needs a rehash again — so there is no rehash loop.
  const versioned = splitPepperId(stored);
  if (!versioned) return true;
  if (versioned.id !== PEPPER_ID_CURRENT) return true;
  const phc = versioned.phc;
  if (!phc.startsWith('$argon2id$')) return true;
  const match = phc.match(/\$m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) return true;
  const [, m, t, p] = match.map(Number);
  return (
    m < ARGON2_PARAMS.memorySize ||
    t < ARGON2_PARAMS.iterations ||
    p < ARGON2_PARAMS.parallelism
  );
}
