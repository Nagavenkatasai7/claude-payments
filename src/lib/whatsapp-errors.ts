// Program-Fix 25 PR A — honest sends: a PURE classifier for Meta Graph send
// rejections. No imports from whatsapp.ts (whatsapp.ts imports this file).
//
// Meta: "Build your app's error handling around error codes instead of subcodes
// or HTTP response status codes"
// (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/).
// That page lists 131047 (more than 24h since the recipient replied), and
// 131026 / 132000 / 132001 / 133010 as conditions a retry cannot fix; 131049,
// 131056 and 190 are fixed by waiting or by ops (a new token) and so stay
// retryable. 131030 ("Recipient phone number not in allowed list") is NOT on
// that page — its evidence is the production dead-row body (the sandbox
// allow-list), and a retry cannot fix it either.

import type { PartnerId } from './types';

export type GraphErrorKind = 'window' | 'permanent' | 'retryable';

/** 24h customer-service window closed: only a template can reach the user. */
const WINDOW_CODES: ReadonlySet<number> = new Set([131047]);
/** A retry of the SAME request cannot succeed. */
const PERMANENT_CODES: ReadonlySet<number> = new Set([131030, 131026, 132000, 132001, 133010]);

/** Read `error.code` / `error.message` from a Graph JSON body. Garbage ⇒ {}. */
export function parseGraphError(_status: number, body: string): { code?: number; title?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return {};
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'number' || !Number.isInteger(code)) return {};
  return typeof message === 'string' ? { code, title: message } : { code };
}

/** Unknown / absent code ⇒ retryable: an unparseable reply is never terminal. */
export function classifyGraphCode(code: number | undefined): GraphErrorKind {
  if (code === undefined) return 'retryable';
  if (WINDOW_CODES.has(code)) return 'window';
  if (PERMANENT_CODES.has(code)) return 'permanent';
  return 'retryable';
}

/**
 * A non-OK Graph reply. The MESSAGE is byte-for-byte the string the plain
 * `Error` carried before this fix (`${label} (${status}): ${body}`), because the
 * dead-row alerts and ops-diagnosis parse it. `code` / `kind` are extra fields.
 */
export class WhatsAppSendError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly kind: GraphErrorKind;

  constructor(message: string, info: { status: number; code?: number }) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.status = info.status;
    this.code = info.code;
    this.kind = classifyGraphCode(info.code);
  }

  static fromResponse(label: string, status: number, body: string): WhatsAppSendError {
    return new WhatsAppSendError(`${label} (${status}): ${body}`, { status, code: parseGraphError(status, body).code });
  }
}

/** A 24h-window rejection: code 131047, or the legacy HTTP 470 kept alongside it. */
export function isWindowError(err: unknown): boolean {
  return err instanceof WhatsAppSendError && (err.kind === 'window' || err.status === 470);
}

/**
 * Inside the 24h customer-service window? Reads the EXISTING inbound marker
 * `lastmsg:{partner}:{phone}` (24h TTL, written on every inbound message). A
 * read error counts as OUTSIDE the window — the conservative answer.
 */
export async function isInServiceWindow(
  store: { getLastInboundAt(partnerId: PartnerId, phone: string): Promise<string | null> },
  partnerId: PartnerId,
  phone: string,
): Promise<boolean> {
  try {
    return Boolean(await store.getLastInboundAt(partnerId, phone));
  } catch {
    return false;
  }
}
