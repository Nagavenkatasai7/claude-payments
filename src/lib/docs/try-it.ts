import { keyModeFromPlaintext } from '@/lib/partner-api-scopes';

// try-it — the pure parse / validate / forward-build rules behind the docs "Try it" proxy
// (POST /api/docs/try-it, UI redesign M4 PR-5). PURE: no I/O, no logging.
//
// Security rules (plan M4 Task 5.1, review focus 2 and 3):
// - a CLOSED set of operations: read-only or stateless ones a sandbox key may call. Mint and
//   confirm are excluded (a sandbox settle still enqueues customer-facing WhatsApp sends), and
//   rates / settlements / beneficiaries:write are not sandbox scopes at all;
// - sandbox keys (sr_test_) ONLY, decided by prefix with no lookup, so a pasted live key is
//   refused before any key-bearing Redis or DB call and there is no timing oracle;
// - route params come from the operation, never from a client path; the only path param (id) is
//   a strict charset, so no `../`, `/` or `%2F` can be smuggled into the forwarded URL;
// - every rejection is a fixed string: the key is never echoed.

export const TRY_IT_OPERATIONS = ['listCorridors', 'createQuote', 'validateBeneficiary', 'listTransactions', 'getTransaction'] as const;
export type TryItOperation = (typeof TRY_IT_OPERATIONS)[number];

export const TRY_IT_MAX_BODY_BYTES = 16_384;
export const TRY_IT_RATE_SCOPE = 'docs-tryit';
export const TRY_IT_IP_LIMIT = 20; // per IP per 60 s
export const TRY_IT_LIVE_KEY_ERROR = 'Try it accepts sandbox keys (sr_test_…) only.';
export const TRY_IT_INVALID = 'Invalid request.';

export type TryItParsed = {
  ok: true;
  op: TryItOperation;
  key: string;
  id?: string;
  query: { limit?: string; cursor?: string };
  body: Record<string, unknown>;
};
export type TryItReject = { ok: false; status: 400 | 413 | 415; error: string };

type Target = { method: 'GET' | 'POST'; path: string };
const TARGETS: Record<TryItOperation, Target> = {
  listCorridors: { method: 'GET', path: '/api/partner/v1/corridors' },
  createQuote: { method: 'POST', path: '/api/partner/v1/quote' },
  validateBeneficiary: { method: 'POST', path: '/api/partner/v1/beneficiaries/validate' },
  listTransactions: { method: 'GET', path: '/api/partner/v1/transactions' },
  getTransaction: { method: 'GET', path: '/api/partner/v1/transactions' }, // + `/${id}`
};

// Printable ASCII, no space: a header-safe token (no CR/LF injection, no whitespace, no controls).
const KEY_RE = /^[\x21-\x7e]{1,256}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LIMIT_RE = /^\d{1,3}$/;
const CURSOR_RE = /^[\x21-\x7e]{1,256}$/;

const reject = (status: 400 | 413 | 415, error: string = TRY_IT_INVALID): TryItReject => ({ ok: false, status, error });
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Membership in the closed operation set (the reference page renders the form only for these). */
export function isTryItOperation(v: unknown): v is TryItOperation {
  return typeof v === 'string' && (TRY_IT_OPERATIONS as readonly string[]).includes(v);
}

/** UTF-8 byte length (the cap is on bytes, not characters). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** A JSON media type: `application/json`, optionally followed by parameters (`; charset=utf-8`). */
export function isJsonContentType(contentType: string | null): boolean {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function parseTryItRequest(contentType: string | null, raw: string): TryItParsed | TryItReject {
  if (!isJsonContentType(contentType)) return reject(415, 'Send the request as application/json.');
  if (utf8Bytes(raw) > TRY_IT_MAX_BODY_BYTES) return reject(413, 'Request too large.');
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return reject(400);
  }
  if (!isPlainObject(doc)) return reject(400);
  if (!isTryItOperation(doc.operationId)) return reject(400);
  const op = doc.operationId;

  const key = doc.key;
  if (typeof key !== 'string' || !KEY_RE.test(key) || keyModeFromPlaintext(key) !== 'test') {
    return reject(400, TRY_IT_LIVE_KEY_ERROR);
  }

  const params = doc.params ?? {};
  if (!isPlainObject(params)) return reject(400);

  const out: TryItParsed = { ok: true, op, key, query: {}, body: {} };
  if (op === 'getTransaction') {
    if (typeof params.id !== 'string' || !ID_RE.test(params.id)) return reject(400);
    out.id = params.id;
  }
  if (op === 'listTransactions') {
    if (params.limit !== undefined) {
      if (typeof params.limit !== 'string' || !LIMIT_RE.test(params.limit)) return reject(400);
      out.query.limit = params.limit;
    }
    if (params.cursor !== undefined) {
      if (typeof params.cursor !== 'string' || !CURSOR_RE.test(params.cursor)) return reject(400);
      out.query.cursor = params.cursor;
    }
  }
  if (TARGETS[op].method === 'POST') {
    if (!isPlainObject(doc.body)) return reject(400);
    out.body = doc.body;
  }
  return out;
}

/**
 * The in-process forward target. The path is built from the operation (a closed enum) plus the
 * validated id only; the query is encoded by URLSearchParams.
 */
export function forwardTarget(p: TryItParsed): { method: 'GET' | 'POST'; path: string; search: string; hasBody: boolean } {
  const t = TARGETS[p.op];
  const path = p.op === 'getTransaction' ? `${t.path}/${encodeURIComponent(p.id ?? '')}` : t.path;
  const qs = new URLSearchParams();
  if (p.op === 'listTransactions') {
    if (p.query.limit !== undefined) qs.set('limit', p.query.limit);
    if (p.query.cursor !== undefined) qs.set('cursor', p.query.cursor);
  }
  const s = qs.toString();
  return { method: t.method, path, search: s ? `?${s}` : '', hasBody: t.method === 'POST' };
}

/**
 * A same-origin browser request. True iff `sec-fetch-site` is `same-origin`, or it is absent and
 * `origin` equals the expected origin. A present `origin` that differs always fails, and
 * `same-site` (a sibling partner subdomain), `cross-site` and `none` fail.
 */
export function isSameOriginRequest(headers: Headers, expectedOrigin: string): boolean {
  const site = headers.get('sec-fetch-site');
  const origin = headers.get('origin');
  if (origin !== null && origin !== expectedOrigin) return false;
  if (site !== null) return site === 'same-origin';
  return origin === expectedOrigin;
}
