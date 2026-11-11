// Fix pack 6 (R46, P5) — the E-SIGN consent gate of ONE pay POST. SERVER module (it
// reads the customer repo): a 'use client' file must never import it.
//
// Called pre-verify on the pay POST only (transfer, draft and link branches, after
// every cheap check and before the code is verified), NEVER at request_otp (P0 rule
// 12: old JS shows "try again" for an unknown request_otp reason for ever). It spends
// no code and writes nothing: on `consent` the route puts the version into the
// payment evidence, and commitPaymentEvidence (P6) writes it in the evidence
// transaction.
//
// Who is exempt (D2, P5): ACH debit payments only (`fundingMethod === 'ach_pull'`, the
// row's, else the draft's). A non-ACH b2b row or draft paid on /api/pay/[transferId]
// is asked like a b2c payment; links are never exempt; Partner-API rows opened on
// /pay are not exempt; the b2b bill route and the Partner API confirm never call it.
//
// The customer is the OWNER (partnerId, phone), never the routed rail. An undefined
// owner is `unavailable` (503): consent cannot be read without it (P5 overrides PR4
// M8 for this step only).

import type { DbOrTx } from '@/db/client';
import { readEsignConsent } from '@/db/repos/customer-repo';
import { esignConsentNeeded, isCurrentEsignVersion } from '@/lib/esign';
import { logWarn } from '@/lib/log';
import type { ParsedPayBody } from '@/lib/pay-body';
import type { PartnerId } from '@/lib/types';

export type EsignGateResult =
  | { kind: 'not_needed' }
  | { kind: 'consent'; version: string }
  | { kind: 'reload_required' }
  | { kind: 'unavailable' };

/**
 * not_needed: exempt (no read) or a current consent on file (nothing to write).
 * consent: needed and the page posted the current version (the route adds it to the evidence).
 * reload_required: needed and the page posted no version, an empty one, a stale one or a
 * non-string (an old tab): the route answers payReloadRequired(funded), 409.
 * unavailable: the owner is unresolved or the read failed: payTemporarilyUnavailable(), 503.
 * Logs only the error NAME and the tenant (never the error object, its message or the phone).
 */
export async function payEsignGate(
  db: DbOrTx,
  i: {
    ownerId: PartnerId | undefined;
    phone: string;
    exempt: boolean;
    body: Pick<ParsedPayBody, 'esignConsentVersion' | 'present'>;
  },
): Promise<EsignGateResult> {
  if (i.exempt) return { kind: 'not_needed' };
  if (i.ownerId === undefined) {
    logWarn('pay.esign-gate', 'owner_unresolved', {});
    return { kind: 'unavailable' };
  }
  let needed: boolean;
  try {
    needed = esignConsentNeeded(await readEsignConsent(db, i.ownerId, i.phone));
  } catch (err) {
    logWarn('pay.esign-gate', err instanceof Error ? err.name : 'error', { partnerId: i.ownerId });
    return { kind: 'unavailable' };
  }
  if (!needed) return { kind: 'not_needed' };
  if (isCurrentEsignVersion(i.body.esignConsentVersion)) return { kind: 'consent', version: i.body.esignConsentVersion };
  return { kind: 'reload_required' };
}
