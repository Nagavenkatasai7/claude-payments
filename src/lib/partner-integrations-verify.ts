// Program-Fix 30 (F64): prove a partner's access token controls the WhatsApp
// phone_number_id it is registering BEFORE that pnid is stored. A pnid alone
// routes inbound traffic on the shared webhook to one tenant, so a squatter
// could otherwise block the real owner's registration and have the owner's
// inbound events verified against the squatter's app secret (→ 401, dropped).
//
// Meta Graph (Business Management API — "Manage phone numbers"):
//   GET /{phone-number-id}             → { id, display_phone_number, verified_name, … }
//   GET /{waba-id}/phone_numbers       → { data: [{ id, display_phone_number, verified_name, … }] }
// https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers/
//
// FAIL-CLOSED: any non-2xx, timeout, network error or malformed body is
// { ok: false }. This is registration, not a money path — a refused save can
// simply be retried. The token rides ONLY in the Authorization header and is
// never logged here (the caller logs partnerId + status only).
import { META_TIMEOUT_MS } from './whatsapp';

const GRAPH = 'https://graph.facebook.com/v21.0'; // same version as whatsapp.ts sends
const PNID_RE = /^\d{5,20}$/;
const WABA_RE = /^\d{1,30}$/;

export type OwnershipResult = { ok: true } | { ok: false; status?: number };

export interface VerifyPhoneNumberOwnershipInput {
  pnid: string;
  token: string;
  wabaId?: string;
  /** Test/DI seam; defaults to the global fetch resolved AT CALL TIME (so vi.stubGlobal works). */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export async function verifyPhoneNumberOwnership(input: VerifyPhoneNumberOwnershipInput): Promise<OwnershipResult> {
  const { pnid, token, wabaId } = input;
  // Validate BEFORE anything reaches a URL (no path/query injection).
  if (!PNID_RE.test(pnid) || !token) return { ok: false };
  if (wabaId !== undefined && !WABA_RE.test(wabaId)) return { ok: false };

  const doFetch = input.fetchFn ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const timeoutMs = input.timeoutMs ?? META_TIMEOUT_MS;
  // A fresh signal PER CALL: AbortSignal.timeout starts counting at creation.
  const get = (url: string) =>
    doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

  try {
    const res = await get(`${GRAPH}/${pnid}?fields=id,display_phone_number,verified_name`);
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { id?: unknown } | null;
    if (body?.id !== pnid) return { ok: false, status: res.status };

    if (wabaId !== undefined) {
      const list = await get(`${GRAPH}/${wabaId}/phone_numbers`);
      if (!list.ok) return { ok: false, status: list.status };
      const lb = (await list.json()) as { data?: unknown } | null;
      const listed = Array.isArray(lb?.data) && lb.data.some((d: { id?: unknown } | null) => d?.id === pnid);
      if (!listed) return { ok: false, status: list.status };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
