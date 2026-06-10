// boot-assert — the production fail-closed gate (Stage 3). A money platform
// must never boot half-configured: an empty META_APP_SECRET silently accepts
// forged webhooks, an empty PASSWORD_PEPPER mints weak hashes, an empty
// FIELD_ENCRYPTION_KEY breaks every decrypt. instrumentation.ts calls this at
// server start and throws — the function instance refuses to serve.
//
// Pure + DI'd (takes the env record) so the matrix is unit-tested without
// touching process.env.

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
  if (key !== '' && !/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push('FIELD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return problems;
}
