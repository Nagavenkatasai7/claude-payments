// infra-error — is this failure the INFRASTRUCTURE's (retry later) or the
// message's (retrying will never help)? R1: the inbound WhatsApp webhook
// returns 500 — so Meta redelivers — ONLY for the former. It is an ALLOWLIST:
// anything not recognised here is treated as a per-message failure, which the
// webhook acknowledges and audits. One poison body must never make Meta retry
// for days.
//
// Sources for the shapes matched:
//   • drizzle wraps driver errors: DrizzleQueryError.cause
//     (node_modules/drizzle-orm/errors.d.ts:9-14, drizzle-orm 0.45.2).
//   • Neon serverless: DatabaseError/NeonDbError carry the SQLSTATE in `code`
//     (node_modules/@neondatabase/serverless/index.d.ts:313-317, :795-798); the
//     pool's connect/terminate messages are literal strings in its index.js.
//   • Upstash REST client: a failed fetch is rethrown after its retries, else
//     "Exhausted all retries"; a non-JSON error body is UpstashJSONParseError;
//     a JSON error body is UpstashError(`${error}, command was: ...`)
//     (node_modules/@upstash/redis/chunk-S6LIPXJD.mjs:167-203, v1.38.1).

/** SQLSTATE classes that mean "the database, not the row": connection (08), resources (53). */
const INFRA_SQLSTATE_CLASSES = ['08', '53'];

/** Individual transient SQLSTATEs: shutdown / cannot-connect-now, statement timeout, serialization, deadlock. */
const INFRA_SQLSTATES: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03', '57014', '40001', '40P01']);

/** Node / undici network error codes. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const INFRA_MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|encountered a connection error|exhausted all retries|exceeded the [\w\s-]*quota|socket hang up/i;

/** An Upstash JSON error that is the service's capacity, not our command. */
const UPSTASH_INFRA_MESSAGE = /limit exceeded|timed? ?out|unavailable|try again/i;

const MAX_CAUSE_DEPTH = 6;

function isInfraLink(e: Record<string, unknown>): boolean {
  const code = typeof e.code === 'string' ? e.code : '';
  if (code) {
    if (NETWORK_CODES.has(code) || INFRA_SQLSTATES.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code) && INFRA_SQLSTATE_CLASSES.includes(code.slice(0, 2))) return true;
  }
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (name === 'UpstashJSONParseError') return true;
  if (name === 'UpstashError') return UPSTASH_INFRA_MESSAGE.test(message);
  return INFRA_MESSAGE.test(message);
}

/**
 * True when `err` (or anything on its `.cause` chain) is an infrastructure
 * failure: a DB / pool / connection error, or a Redis timeout / connection
 * error. Pure; never throws.
 */
export function isInfraError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || typeof cur !== 'object' || seen.has(cur)) return false;
    seen.add(cur);
    if (isInfraLink(cur as Record<string, unknown>)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
