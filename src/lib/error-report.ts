// error-report — the server error-capture seam (Program-Fix 26, obs-01).
//
// `onRequestError` in src/instrumentation.ts hands every server error here.
// buildErrorReport keeps a fixed allowlist of fields, each scrubbed; the
// request path (it can carry pay/verify/reset tokens), headers, cookies, the
// body, err.stack and err.cause are NEVER read into the report.
// reportRequestError sends it to Sentry as ONE envelope by plain fetch — no SDK,
// no next.config wrapper, no client code, no CSP change — and is a no-op unless
// SENTRY_DSN parses.
//
// EDGE-SAFE: `onRequestError` may run in either runtime
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md,
// "Specifying the runtime"). So: fetch, AbortSignal.timeout, globalThis.crypto
// only; process.env.SENTRY_DSN is read directly (not through env.ts); the only
// import is the console-only logger/scrubber (log.ts).
//
// Wire format (cited):
//   - DSN `{PROTOCOL}://{PUBLIC_KEY}:{SECRET_KEY}@{HOST}{PATH}/{PROJECT_ID}`, endpoint
//     `{PROTOCOL}://{HOST}{PATH}/api/{PROJECT_ID}/{ENDPOINT}/`, header
//     `X-Sentry-Auth: Sentry sentry_version=7, sentry_client=…, sentry_key=…`
//     — https://develop.sentry.dev/sdk/foundations/transport/authentication/
//   - Envelope = header line, then per item an item-header line and a payload
//     line; `POST /api/<project_id>/envelope/`; content type
//     `application/x-sentry-envelope`; an item without `length` runs to the next
//     newline — https://develop.sentry.dev/sdk/data-model/envelopes/

import { logWarn, scrub } from '@/lib/log';

export interface ErrorReport {
  /** Scrubbed error message with every URL's query string and fragment removed. */
  message: string;
  /** Scrubbed error class name (e.g. TypeError). */
  type: string;
  /** Next's error digest, only when it is a plain token. */
  digest?: string;
  /** The route FILE path (e.g. /app/pay/[id]/page) — never the request path. */
  routePath?: string;
  routeType?: string;
  method?: string;
}

/** Longest message we forward; scrub() caps at 8 KB anyway. */
const MAX_MESSAGE = 2_000;
/** Deadline on the Sentry POST: an error report never holds a request open for long. */
export const SENTRY_TIMEOUT_MS = 3_000;
const CLIENT = 'smartremit-fetch/1.0';

const ABSOLUTE_URL_QUERY = /(https?:\/\/[^\s?#]+)[?#]\S*/g;
const PATH_QUERY = /((?:^|[\s("'=])\/[^\s?#]*)[?#]\S*/g;

/** Remove the `?query` and `#fragment` from every absolute URL and every `/path` in `s`. */
export function stripUrlQueries(s: string): string {
  return s.replace(ABSOLUTE_URL_QUERY, '$1').replace(PATH_QUERY, '$1');
}

/** Read one value, swallowing a throwing getter (a hostile thrown object). */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A plain token (no spaces, separators or URLs); anything else is dropped. */
function token(v: unknown, re: RegExp): string | undefined {
  return typeof v === 'string' && re.test(v) ? v : undefined;
}

function rawMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  // A thrown non-Error: take `.message` only when it is a string — never
  // stringify the object (it could carry a stack, a cause or a payload).
  const m = safe(() => (err as { message?: unknown } | null)?.message);
  return typeof m === 'string' ? m : 'non-Error value thrown';
}

/**
 * The scrubbed, allowlisted view of one server error. Pure; never throws.
 * `request` is read for its method only.
 */
export function buildErrorReport(
  err: unknown,
  request: { readonly method?: unknown },
  context: { readonly routePath?: unknown; readonly routeType?: unknown },
): ErrorReport {
  const message = safe(() => scrub(stripUrlQueries(rawMessage(err)).slice(0, MAX_MESSAGE))) ?? 'unreadable error';
  const type = safe(() => (err instanceof Error ? scrub(err.name).slice(0, 100) : 'NonError')) ?? 'Unknown';
  const report: ErrorReport = { message, type };
  const digest = token(
    safe(() => (typeof err === 'object' && err !== null ? (err as { digest?: unknown }).digest : undefined)),
    /^[A-Za-z0-9_-]{1,64}$/,
  );
  if (digest) report.digest = digest;
  const routePath = safe(() => context.routePath);
  if (typeof routePath === 'string' && routePath) {
    report.routePath = scrub(stripUrlQueries(routePath)).slice(0, 200);
  }
  const routeType = token(safe(() => context.routeType), /^[a-z]{1,20}$/);
  if (routeType) report.routeType = routeType;
  const method = token(safe(() => request.method), /^[A-Z]{3,7}$/);
  if (method) report.method = method;
  return report;
}

export interface SentryTarget {
  dsn: string;
  publicKey: string;
  envelopeUrl: string;
}

/** Parse a Sentry DSN; null when unset or not a valid http(s) DSN with a key and numeric project id. */
export function parseSentryDsn(raw: string | undefined): SentryTarget | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.username) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  return {
    dsn: raw,
    publicKey: decodeURIComponent(u.username),
    envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`,
  };
}

function envelope(report: ErrorReport, target: SentryTarget): string {
  const eventId = globalThis.crypto.randomUUID().replace(/-/g, '');
  const now = new Date();
  const tags: Record<string, string> = {};
  if (report.routePath) tags.routePath = report.routePath;
  if (report.routeType) tags.routeType = report.routeType;
  if (report.method) tags.method = report.method;
  if (process.env.NEXT_RUNTIME) tags.runtime = process.env.NEXT_RUNTIME;
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: 'error',
    logger: 'next.onRequestError',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    ...(process.env.VERCEL_GIT_COMMIT_SHA ? { release: process.env.VERCEL_GIT_COMMIT_SHA } : {}),
    ...(report.routePath ? { transaction: report.routePath } : {}),
    exception: { values: [{ type: report.type, value: report.message }] },
    tags,
    ...(report.digest ? { extra: { digest: report.digest } } : {}),
  };
  return [
    JSON.stringify({ event_id: eventId, dsn: target.dsn, sent_at: now.toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n') + '\n';
}

/**
 * Send one report to Sentry. A no-op when SENTRY_DSN is unset or unparseable.
 * Never throws: a failed send is one warning line and nothing more.
 */
export async function reportRequestError(report: ErrorReport, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    const target = parseSentryDsn(process.env.SENTRY_DSN);
    if (!target) return;
    const res = await fetchFn(target.envelopeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=${CLIENT}`,
      },
      body: envelope(report, target),
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
    if (!res.ok) logWarn('error-report', `sentry HTTP ${res.status}`);
  } catch (err) {
    // Fixed text: never echo the DSN or the fetch error's message.
    logWarn('error-report', `sentry send failed (${err instanceof Error ? err.name : 'error'})`);
  }
}
