import { getPartnerApiKeyStore, type PartnerApiKeyStore } from './partner-api-key';

// partner-api-auth — the guard every /api/partner/* route runs first. It derives
// the tenant (partnerId) from the AUTHENTICATED KEY, never from the request body
// or any path/query param the caller controls. A handler MUST scope every read
// and write to the returned partnerId.

export interface PartnerAuthOk {
  ok: true;
  partnerId: string;
  keyId: string;
}
export interface PartnerAuthErr {
  ok: false;
  status: number;
  error: string;
}
export type PartnerAuthResult = PartnerAuthOk | PartnerAuthErr;

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export async function authenticatePartner(
  req: { headers: { get(name: string): string | null } },
  store: PartnerApiKeyStore = getPartnerApiKeyStore(),
): Promise<PartnerAuthResult> {
  const token = extractBearer(req.headers.get('authorization'));
  if (!token) {
    return { ok: false, status: 401, error: 'Missing or malformed Authorization header.' };
  }
  const auth = await store.authenticate(token);
  if (!auth) {
    // Same message for unknown/revoked — don't disclose which.
    return { ok: false, status: 401, error: 'Invalid or revoked API key.' };
  }
  return { ok: true, partnerId: auth.partnerId, keyId: auth.keyId };
}
