import type { Pool } from '@neondatabase/serverless';
import { logError } from '@/lib/log';

// pool-guard — a dropped Neon connection must not crash the instance and must
// not print the database password.
//
// The incident (2026-10-17 and 2026-11-09): an idle connection dropped, and the
// full DATABASE_URL, password included, went into the Vercel logs. The path, in
// @neondatabase/serverless v1.1.0 (node_modules/@neondatabase/serverless/index.mjs):
//  - :1088-1089  the Pool's idle listener sets `err.client = client`, then
//                emits 'error' on the Pool;
//  - :1115       the Pool builds each client with its own `options` object;
//  - :1308       the client keeps that object as `config`, and the options
//                hold `connectionString`.
// The Pool had no 'error' listener, so the emit threw (EventEmitter throws an
// unhandled 'error'), the exception was uncaught, and Node printed the whole
// error object: err -> client -> config -> connectionString.
//
// Three guards, each pinned in tests/db-pool-guard.test.ts:
//  1. A Pool 'error' listener: the emit no longer throws. A drop logs one
//     `db.pool` line through the scrubbing logger (error name, code, redacted
//     message), never the error object.
//  2. An 'error' listener on every client. The Pool removes its idle listener
//     while a client is checked out (:1126), so a connection that dropped
//     during a transaction had no listener at all and crashed the same way.
//     The in-flight query still rejects with the same error, and the Pool
//     discards the dead client on release, so the request fails normally.
//  3. `connectionString` becomes non-enumerable on the Pool options, the same
//     way the driver already hides `password` (:1091 and :771). The driver
//     reads the property by name (:769, :1314), so it still connects, but
//     printing a client, the Pool or an error that carries one cannot show it.

type ErrorSource = { on(event: 'error', listener: (err: unknown) => void): unknown };

/** Any `scheme://…` run. Credentials ride inside one, so the whole run goes. */
const URL_RUN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const MIN_SECRET_CHARS = 4;

/**
 * Builds the redactor for one connection string: it masks every URL, and every
 * bare copy of the connection string or of its password (raw and decoded).
 */
export function redactorFor(connectionString: string | undefined): (text: string) => string {
  const secrets = new Set<string>();
  if (connectionString) {
    secrets.add(connectionString);
    try {
      const { password } = new URL(connectionString);
      // Raw form first: decodeURIComponent throws on a malformed escape, and
      // the raw password must already be in the set when it does.
      secrets.add(password);
      const decoded = decodeURIComponent(password);
      secrets.add(decoded);
      secrets.add(encodeURIComponent(decoded));
    } catch {
      // Not a parseable URL (or a malformed escape): URL_RUN still applies.
    }
  }
  // Longest first, so the whole connection string wins over the password
  // inside it. Case-insensitive, because a percent-escape can arrive as %2F or
  // %2f. A secret under MIN_SECRET_CHARS is left alone: masking so short a run
  // would shred the line and hide nothing.
  const literals = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const bare = literals.length > 0 ? new RegExp(literals.join('|'), 'gi') : null;
  return (text) => {
    const out = text.replace(URL_RUN, '<url>');
    return bare ? out.replace(bare, '<redacted>') : out;
  };
}

/** The only parts of a driver error that reach a log line. Never the object. */
export function dbErrorFields(
  err: unknown,
  redact: (text: string) => string = redactorFor(undefined),
): Record<string, string> {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const fields: Record<string, string> = {
    name: redact(typeof e.name === 'string' ? e.name : 'UnknownError'),
  };
  if (typeof e.code === 'string') fields.code = redact(e.code);
  const detail = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  if (detail) fields.detail = redact(detail);
  return fields;
}

function hideConnectionString(options: { connectionString?: string }): void {
  if (typeof options.connectionString !== 'string') return;
  Object.defineProperty(options, 'connectionString', {
    value: options.connectionString,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** Adds the three guards to the ledger Pool. Call once, right after `new Pool`. */
export function guardPool(pool: Pool): void {
  const redact = redactorFor(pool.options.connectionString);
  hideConnectionString(pool.options);

  // One dropped idle connection reaches both listeners with the SAME error
  // object (the client emits it, the idle listener forwards it to the Pool).
  const reported = new WeakSet<object>();
  const report = (err: unknown): void => {
    // A listener must never throw: a throw here is the same uncaught exception
    // that this guard exists to stop.
    try {
      if (typeof err === 'object' && err !== null) {
        // The idle listener hung the client on the error. Drop the reference
        // first, on every pass, so nothing later can print the client through
        // it. Reflect.deleteProperty answers false where `delete` would throw.
        Reflect.deleteProperty(err, 'client');
        if (reported.has(err)) return;
        reported.add(err);
      }
      logError('db.pool', 'database connection dropped', dbErrorFields(err, redact));
    } catch {
      // Nothing safe is left to do with this error.
    }
  };

  // One scope for both listeners. The client listener is added first (at
  // 'connect'; the Pool re-adds its idle listener at each release, :1120-1126),
  // so it sees every drop, idle or not; the Pool listener is what stops the
  // idle emit from throwing.
  pool.on('error', report);
  // Side effect to know about: any Pool listener other than 'error' makes the
  // driver send pool.query over the WebSocket, never over fetch (:1351-1352).
  // That is already the case here (neonConfig.poolQueryViaFetch is off, :427).
  pool.on('connect', (client: ErrorSource) => {
    client.on('error', report);
  });
}
