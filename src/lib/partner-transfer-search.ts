import { decryptField, encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { PartnerId } from '@/lib/types';

// partner-transfer-search (lost-features restore p1 B1). SERVER-ONLY for the seal/open half: it
// seals with FIELD_ENCRYPTION_KEY. The /partner transfer list promises that no name or phone ever
// enters a URL, so a name / phone / last-4 search is sealed into an opaque token
// (`tsq1|<partnerId>|<username>|<expMs>|<kind>|<value>`, purpose `transfer_search`) bound to the
// tenant, the user and a 30-minute expiry. Anything that does not open for THIS session is ignored.
// parseTransferQuery is pure: it classifies the typed text into a closed shape before any query.

export const TRANSFER_SEARCH_TTL_MS = 30 * 60_000;
export const TRANSFER_SEARCH_MAX = 64;

export type TransferQuery = { kind: 'text'; value: string } | { kind: 'digits'; value: string };

const SEARCH_CTX = ctx.purpose('transfer_search');
const PREFIX = 'tsq1|';
// v1: `v1.<iv>.<tag>.<wdek>.<ct>`; v2: `v2.<kid>.<iv>.<tag>.<wdek>.<ct>` (the customer-ref shape).
const TOKEN_SHAPE = /^(?:v1|v2\.[a-z0-9]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN_MAX = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PHONE_PUNCT = /[\s+\-().]/g;
const HAS_LETTER = /\p{L}/u;

/**
 * The typed search as a closed shape, or null for anything not worth a query:
 *  - digits: 4 to 15 digits once `+ - ( ) .` and spaces are dropped (last 4 of the account, or a
 *    sender phone, matched as a suffix);
 *  - text: at least 2 characters with a letter (a recipient name fragment or a transfer id prefix).
 */
export function parseTransferQuery(raw: unknown): TransferQuery | null {
  if (typeof raw !== 'string') return null;
  if (CONTROL.test(raw)) return null;
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v.length === 0 || v.length > TRANSFER_SEARCH_MAX) return null;
  const digits = v.replace(PHONE_PUNCT, '');
  if (/^\d+$/.test(digits)) return digits.length >= 4 && digits.length <= 15 ? { kind: 'digits', value: digits } : null;
  if (!HAS_LETTER.test(v) || v.length < 2) return null;
  return { kind: 'text', value: v };
}

/** Seal a parsed query for (tenant, user), valid for TRANSFER_SEARCH_TTL_MS from `nowMs`. */
export function sealTransferSearch(partnerId: PartnerId, username: string, q: TransferQuery, nowMs: number): string {
  return encryptField(`${PREFIX}${partnerId}|${username}|${nowMs + TRANSFER_SEARCH_TTL_MS}|${q.kind}|${q.value}`, undefined, SEARCH_CTX);
}

/**
 * The query behind a token, or null (never throws) for anything that is not a live token sealed for
 * exactly this tenant and user: junk, tampered, expired, minted for someone else, or another sealed
 * purpose. The query is re-validated after opening.
 */
export function openTransferSearch(token: unknown, partnerId: PartnerId, username: string, nowMs: number): TransferQuery | null {
  if (typeof token !== 'string' || token.length > TOKEN_MAX || !TOKEN_SHAPE.test(token)) return null;
  let plain: string;
  try {
    plain = decryptField(token, undefined, SEARCH_CTX);
  } catch {
    return null;
  }
  // The binding is checked by rebuilding the expected prefix, so a '|' in a username or tenant id
  // can never shift the fields.
  const bound = `${PREFIX}${partnerId}|${username}|`;
  if (!plain.startsWith(bound)) return null;
  const rest = plain.slice(bound.length);
  const m = /^(\d{1,16})\|(text|digits)\|([\s\S]*)$/.exec(rest);
  if (!m) return null;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || nowMs >= exp || exp - nowMs > TRANSFER_SEARCH_TTL_MS) return null;
  const q = parseTransferQuery(m[3]);
  return q && q.kind === m[2] && q.value === m[3] ? q : null;
}
