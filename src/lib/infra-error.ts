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

// Neon pool / pg client strings (@neondatabase/serverless 1.1.0 index.js), ws
// handshake strings (ws lib/websocket.js:305, :369, :495, :933) and Neon's
// documented wake / capacity failures
// (https://neon.com/docs/connect/connection-errors: "Couldn't connect to
// compute node", "Can't reach database server", "active endpoints limit
// exceeded" / "exceeded the limit of concurrently active endpoints",
// "query_wait_timeout", "Remaining connection slots are reserved").
const INFRA_MESSAGE = new RegExp(
  [
    'timeout exceeded when trying to connect',
    'connection terminated',
    'encountered a connection error',
    'client was closed and is not queryable',
    'query read timeout',
    'error establishing an SSL connection',
    'websocket was closed before the connection was established',
    'websocket is not open',
    'unexpected server response',
    'exhausted all retries',
    'exceeded the [\\w\\s-]*quota',
    'socket hang up',
    "couldn't connect to compute node",
    "can't reach database server",
    'active endpoints limit exceeded',
    'exceeded the limit of concurrently active endpoints',
    'query_wait_timeout',
    'remaining connection slots are reserved',
  ].join('|'),
  'i',
);

/** An Upstash JSON error that is the service's capacity, not our command. */
const UPSTASH_INFRA_MESSAGE = /limit exceeded|timed? ?out|unavailable|try again/i;

const MAX_CAUSE_DEPTH = 6;

/** SQLSTATE shape: 5 chars of [0-9A-Z]. XX000 is Postgres "internal_error" — the Neon proxy reports compute failures under it. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const SERVER_INTERNAL = 'XX000';

type Verdict = 'infra' | 'not_infra' | 'continue';

/**
 * Classify ONE link. Code and name decide first; a message is read only where
 * it cannot hold caller data:
 *   • a link carrying `query` / `params` (drizzle's DrizzleQueryError — its
 *     message is `Failed query: ${query}\nparams: ${params}`,
 *     node_modules/drizzle-orm/errors.js:10-13, i.e. payload text) is judged
 *     by its cause chain only;
 *   • a SQLSTATE `code` is DECISIVE: infra class/set ⇒ infra, anything else
 *     ⇒ not infra — except XX000, where this link's own message decides;
 *   • an UpstashError is read only before ", command was:" (the suffix echoes
 *     the command and its values).
 */
function classifyLink(e: Record<string, unknown>): Verdict {
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';

  if (code && NETWORK_CODES.has(code)) return 'infra';
  if (code && SQLSTATE.test(code)) {
    if (INFRA_SQLSTATES.has(code) || INFRA_SQLSTATE_CLASSES.includes(code.slice(0, 2))) return 'infra';
    if (code === SERVER_INTERNAL) return INFRA_MESSAGE.test(message) ? 'infra' : 'not_infra';
    return 'not_infra';
  }
  if (name === 'TimeoutError' || name === 'AbortError') return 'infra';
  if (name === 'UpstashJSONParseError') return 'infra';
  if (name === 'UpstashError') {
    const head = message.split(', command was:')[0];
    return UPSTASH_INFRA_MESSAGE.test(head) || INFRA_MESSAGE.test(head) ? 'infra' : 'continue';
  }
  if ('query' in e || 'params' in e) return 'continue'; // never read a query error's message
  return INFRA_MESSAGE.test(message) ? 'infra' : 'continue';
}

/**
 * True when `err` (or anything it wraps) is an infrastructure failure: a DB /
 * pool / connection error, or a Redis timeout / connection error. Follows
 * `.cause` (drizzle, fetch) AND `.error` — neon re-emits the ws ErrorEvent,
 * whose underlying Error sits on `.error` (ws lib/event-target.js:118-133).
 * A non-infra SQLSTATE anywhere on the chain ends the walk as "not infra".
 * Pure; never throws.
 */
export function isInfraError(err: unknown): boolean {
  try {
    return walk(err);
  } catch {
    return false; // a hostile getter: not provably infrastructure
  }
}

function walk(err: unknown): boolean {
  const seen = new Set<unknown>();
  let frontier: unknown[] = [err];
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const cur of frontier) {
      if (cur === null || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      const link = cur as Record<string, unknown>;
      const verdict = classifyLink(link);
      if (verdict === 'infra') return true;
      if (verdict === 'not_infra') return false;
      next.push(link.cause, link.error);
    }
    frontier = next;
  }
  return false;
}
