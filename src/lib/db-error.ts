// db-error — the only description of a failed database query that may leave
// the process (a log line, a column, Sentry, an ops alert, the AI copilot).
//
// drizzle-orm 0.45.3 wraps every driver failure in a DrizzleQueryError
// (node_modules/drizzle-orm/errors.js:10-20; pg-core/session.js:41-48). Its
// message is `Failed query: <sql>\nparams: <values>`, and it carries the
// `params` array and the driver error as `cause`, whose `detail` echoes key
// values (`Key (partner_id, phone)=(default, 1555…) already exists.`). Params
// and detail hold customer data: phones, names, emails, password hashes, reply
// text. This module keeps the SQLSTATE, the Postgres reason, the constraint /
// table / column ids and the head of the SQL text (placeholders only), and
// drops everything else.
//
// Pure and duck-typed: no drizzle import, so it works for errors from any build
// of the package (ESM or CJS) and for driver errors that carry `query`/`params`
// themselves (PGlite's error does).

const FAILED_QUERY = 'Failed query:';
/** The separator before the params: a real newline, a JSON-escaped `\n`, or any whitespace. */
const PARAMS_TAIL = /(\\n|\s)params:[\s\S]*$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_ID = /^[A-Za-z0-9_.$-]{1,80}$/;
const REASON_MAX = 200;
const SQL_MAX = 300;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

function read(o: Obj, key: string): unknown {
  try {
    return o[key];
  } catch {
    return undefined; // a throwing getter
  }
}

function str(o: Obj, key: string): string | undefined {
  const v = read(o, key);
  return typeof v === 'string' ? v : undefined;
}

/** A drizzle query failure (or anything shaped like one). */
export function isQueryError(err: unknown): err is Error & { query: string; params: unknown; cause?: unknown } {
  try {
    if (!isObj(err)) return false;
    if (typeof read(err, 'query') === 'string' && Object.prototype.hasOwnProperty.call(err, 'params')) return true;
    return err instanceof Error && typeof err.message === 'string' && err.message.startsWith(FAILED_QUERY);
  } catch {
    return false;
  }
}

/** Any text: cuts the params of a "Failed query:" message. Idempotent. Never throws. */
export function stripQueryParams(text: string): string {
  if (typeof text !== 'string') return text;
  const at = text.indexOf(FAILED_QUERY);
  if (at < 0) return text;
  const head = text.slice(0, at + FAILED_QUERY.length);
  const rest = text.slice(at + FAILED_QUERY.length);
  // Over-cutting is the safe direction: everything after the first params
  // marker goes, including anything that followed the error in the text.
  return head + rest.replace(PARAMS_TAIL, (_m, sep: string) => `${sep}params: <redacted>`);
}

/** The driver error: the `cause` of a query error, or the error itself when it carries a code. */
function driverError(err: Obj): Obj | undefined {
  const cause = read(err, 'cause');
  if (isObj(cause)) return cause;
  if (typeof read(err, 'code') === 'string') return err;
  return undefined;
}

/** SQLSTATE of the driver error under a query error (or of a bare driver error), when it looks like one. */
export function sqlState(err: unknown): string | undefined {
  try {
    if (!isObj(err)) return undefined;
    for (const o of [read(err, 'cause'), err]) {
      if (!isObj(o)) continue;
      const code = str(o, 'code');
      if (code && SQLSTATE.test(code)) return code;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The SQL text of a query error: `query`, or the message between the marker and the params. */
function sqlHead(err: Obj): string {
  const query = str(err, 'query');
  if (query !== undefined) return cut(collapse(query), SQL_MAX);
  const message = str(err, 'message') ?? '';
  const at = message.indexOf(FAILED_QUERY);
  if (at < 0) return '';
  const body = message.slice(at + FAILED_QUERY.length);
  const end = body.search(/(\\n|\s)params:/);
  return cut(collapse(end < 0 ? body : body.slice(0, end)), SQL_MAX);
}

function reasonOf(driver: Obj | undefined, err: Obj, state: string | undefined): string {
  // Class 22 (data exception): Postgres echoes the offending VALUE in the
  // primary message (`invalid input syntax for type integer: "Ravi Traders"`).
  if (state?.startsWith('22')) return 'data exception (value hidden)';
  if (!driver) return 'unknown cause';
  const message = str(driver, 'message');
  // A bare driver error that is itself the query error has the drizzle
  // message: never use it as the reason.
  if (message && !(driver === err && message.includes(FAILED_QUERY))) {
    const reason = cut(collapse(message), REASON_MAX);
    if (reason) return reason;
  }
  const name = str(driver, 'name');
  return name ? cut(collapse(name), 80) : 'unknown cause';
}

function idsOf(driver: Obj | undefined): string {
  if (!driver) return '';
  let out = '';
  for (const key of ['constraint', 'table', 'column']) {
    const v = str(driver, key);
    if (v && SAFE_ID.test(v)) out += ` ${key}=${v}`;
  }
  return out;
}

/** The only description of a query failure that may reach a log, a column or a third party. Never throws. */
export function queryErrorText(err: unknown): string {
  try {
    const e = isObj(err) ? err : {};
    const state = sqlState(e);
    const driver = isObj(err) ? driverError(e) : undefined;
    return (
      `db query failed [${state ?? 'no SQLSTATE'}] ${reasonOf(driver, e, state)}${idsOf(driver)}` +
      ` | query: ${sqlHead(e)} | params: <redacted>`
    );
  } catch {
    return 'db query failed [no SQLSTATE] unknown cause | query:  | params: <redacted>';
  }
}
