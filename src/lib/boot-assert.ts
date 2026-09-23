// boot-assert — the production fail-closed gate (Stage 3). A money platform
// must never boot half-configured: an empty META_APP_SECRET silently accepts
// forged webhooks, an empty PASSWORD_PEPPER mints weak hashes, an empty
// FIELD_ENCRYPTION_KEY breaks every decrypt. instrumentation.ts calls this at
// server start and throws — the function instance refuses to serve.
//
// Pure + DI'd (takes the env record) so the matrix is unit-tested without
// touching process.env.

import { K0, isKid } from './key-id';

/** Vars that must be present AND non-empty for a production boot. */
export const REQUIRED_PRODUCTION_VARS = [
  'DATABASE_URL', // the ledger
  'KV_REST_API_URL', // sessions/OTPs/drafts/throttles
  'KV_REST_API_TOKEN',
  'FIELD_ENCRYPTION_KEY', // envelope encryption master key
  'PASSWORD_PEPPER', // set-once — argon2 hashes depend on it
  'CRON_SECRET', // /api/worker + /api/cron auth
  'META_APP_SECRET', // inbound WhatsApp signature verification (fail-closed)
  'OPS_ALERT_PHONE', // stuck-money alerts must have somewhere to go
] as const;

type EnvRecord = Record<string, string | undefined>;

/**
 * Whether this boot is the PRODUCTION RUNTIME (assert) vs a build or local
 * context (skip). The traps this dodges, learned the hard way:
 *   • `vercel env pull` writes VERCEL_ENV=production into .env.local AND
 *     blanks sensitive values — so a plain VERCEL_ENV check would brick local
 *     `next dev` (NODE_ENV=development ⇒ skipped) and local `next build`
 *     (NEXT_PHASE=phase-production-build ⇒ skipped).
 *   • CI builds have no VERCEL_ENV at all ⇒ skipped.
 * Vercel's production runtime is the one context with VERCEL_ENV=production +
 * NODE_ENV=production + no build phase — exactly where secrets must exist.
 */
export function shouldAssertProductionBoot(env: EnvRecord): boolean {
  return (
    env.VERCEL_ENV === 'production' &&
    env.NODE_ENV === 'production' &&
    env.NEXT_PHASE !== 'phase-production-build'
  );
}

/**
 * Whether the master key is one of the TWO shapes EnvKeyProvider actually
 * accepts (field-crypto.ts): 64 hex chars, or base64 decoding to exactly
 * 32 bytes. This MUST mirror that code — the first deploy of this assert
 * used a hex-only check, rejected the (valid, base64) production key, and
 * took down every function and the middleware platform-wide. The assert's
 * contract is the code's contract, not an idealized one.
 */
export function isValidMasterKey(raw: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return true;
  // A runtime without Buffer (edge bundle without the polyfill) must fail
  // OPEN on the shape check — presence is still enforced above, and the Node
  // functions (where crypto actually runs) enforce the shape.
  if (typeof Buffer === 'undefined') return true;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * Every problem that must block a production boot. Returns var NAMES and
 * shape complaints only — never values.
 */
export function productionBootProblems(env: EnvRecord): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_PRODUCTION_VARS) {
    if (!env[name] || env[name].trim() === '') {
      problems.push(`${name} is missing or empty`);
    }
  }
  // A malformed master key must never silently produce garbage crypto.
  const key = (env.FIELD_ENCRYPTION_KEY ?? '').trim();
  if (key !== '' && !isValidMasterKey(key)) {
    problems.push('FIELD_ENCRYPTION_KEY must be 64 hex chars or base64 for exactly 32 bytes');
  }
  const kidProblem = currentKidProblem(env);
  if (kidProblem) problems.push(kidProblem);
  return problems;
}

/**
 * Program-Fix 45 P4: FIELD_ENCRYPTION_CURRENT_KID, checked ONLY when set
 * (production leaves it unset ⇒ no check, boot unchanged). It MUST accept
 * exactly what field-crypto's currentWriteKid accepts — pinned by the
 * agreement matrix in tests/boot-assert.test.ts:
 *  - blank / unset / `k0` → fine (k0 is always FIELD_ENCRYPTION_KEY; the ring
 *    env is not read for it);
 *  - otherwise the kid must match the shared grammar (key-id.ts) AND
 *    FIELD_ENCRYPTION_PREVIOUS_KEYS must parse exactly as parseKeyRingEntries
 *    does (`kid:key` comma list, valid non-k0 kids, no duplicates, each key a
 *    valid master key) and hold that kid.
 * Returns a message naming only the env var — never a kid, an entry or a key.
 */
export function currentKidProblem(env: EnvRecord): string | null {
  const kid = (env.FIELD_ENCRYPTION_CURRENT_KID ?? '').trim() || K0;
  if (kid === K0) return null;
  if (!isKid(kid)) return 'FIELD_ENCRYPTION_CURRENT_KID is not a valid key id';
  const held = new Set<string>();
  for (const entry of (env.FIELD_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    const entryKid = colon > 0 ? trimmed.slice(0, colon).trim() : '';
    const key = colon > 0 ? trimmed.slice(colon + 1).trim() : '';
    if (!isKid(entryKid) || entryKid === K0 || held.has(entryKid) || !isValidMasterKey(key)) {
      return 'FIELD_ENCRYPTION_CURRENT_KID names a key id the key ring (FIELD_ENCRYPTION_PREVIOUS_KEYS) does not hold';
    }
    held.add(entryKid);
  }
  if (!held.has(kid)) {
    return 'FIELD_ENCRYPTION_CURRENT_KID names a key id the key ring (FIELD_ENCRYPTION_PREVIOUS_KEYS) does not hold';
  }
  return null;
}
