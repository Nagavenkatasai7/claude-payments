import { createHash } from 'node:crypto';
import { wizardPrefillFromRequest } from './partner-application-decision';
import type { Partner } from './types';

// partner-from-request (UI redesign M3-21): the pure half of "create a partner from an APPROVED
// partner request". The server action (admin-dashboard/partner-requests/actions.ts) saves the record
// with the same store call the platform wizard uses (createPartnerStore(tx).savePartner).

/** The wizard's SOURCE countries (partners/new/wizard.tsx COUNTRIES). */
export const REQUEST_SOURCE_COUNTRIES = Object.freeze(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ'] as const);

/**
 * The partner id for a request: deterministic, so a double submit (or a replay after a crash)
 * resolves to the SAME partner and the locked existence check refuses the second create. Same shape
 * as a wizard id (newTransferId: 22 base64url chars, never a leading '_' or '-').
 */
export function partnerIdForRequest(requestId: string): string {
  const id = createHash('sha256').update(`smartremit:partner-from-request:v1:${requestId}`).digest('base64url').slice(0, 22);
  return id[0] === '_' || id[0] === '-' ? `p${id.slice(1)}` : id;
}

/**
 * The wizard's defaults for a partner with no branding and no integrations yet: active (so its
 * invited admin can sign in and set it up), SmartRemit KYC, the send gate off. Sandbox-only until
 * go-live is approved (partner_go_live, M3-14).
 */
export function partnerRecordFromRequest(
  request: { companyName: string; corridors: string[] },
  id: string,
  nowIso: string,
): Partner {
  const { name, countries } = wizardPrefillFromRequest(request, REQUEST_SOURCE_COUNTRIES);
  return {
    id,
    name: name.trim(),
    countries: [...countries],
    status: 'active',
    kycMode: 'ours',
    requireKycBeforeSend: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
