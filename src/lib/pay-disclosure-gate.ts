// Fix pack 4 (C10, R18): when the pay step needs a disclosure acknowledgement
// and an approved provider block, and what a missing or stale one answers.
//
// PURE. The acknowledgement and the approved block are mandatory when the
// OWNER is live-certified OR the payment runs on a real-money rail; a B2B
// payment never (a business is not a consumer sender, 12 CFR 1005.30). Not
// mandatory keeps today's lenient server (null for every input).
//
// The caller supplies the inputs (C10): `ownerCertified = isLiveCertified(owner)`
// (an owner read error reads false) and `realMoney` from `realMoneyRail` on the
// integrations in hand (pay-process) or the gate context's `realMoneyKnown`
// (routes). An owner read error therefore refuses only on a real-money rail.
//
// The unapproved check runs BEFORE the ack check, so an old tab on an
// unapproved block reads not_available, never reload_required. An absent
// posted hash passes (the field is optional for one release).

import type { ResolvedDisclosure } from './partner-config';
import { isDisclosureAckVersion } from './remittance-disclosure';

export type DisclosureGateRefusal = 'reload_required' | 'not_available';

export function disclosureMandatory(i: {
  ownerCertified: boolean;
  realMoney: boolean;
  transferType: 'b2c' | 'b2b';
}): boolean {
  if (i.transferType === 'b2b') return false;
  return i.ownerCertified || i.realMoney;
}

export function disclosureGateRefusal(i: {
  mandatory: boolean;
  disclosure: ResolvedDisclosure | null;
  ackVersion: string | null;
  postedHash: string | null;
}): DisclosureGateRefusal | null {
  if (!i.mandatory) return null;
  if (i.disclosure === null || !i.disclosure.partnerApproved) return 'not_available';
  if (!isDisclosureAckVersion(i.ackVersion)) return 'reload_required';
  if (i.postedHash !== null && i.postedHash !== i.disclosure.hash) return 'reload_required';
  return null;
}

/** At request_otp: no code is sent for a mandatory payment without an approved block. */
export function disclosureGateAtRequest(i: {
  mandatory: boolean;
  disclosure: ResolvedDisclosure | null;
}): 'not_available' | null {
  if (!i.mandatory) return null;
  if (i.disclosure === null || !i.disclosure.partnerApproved) return 'not_available';
  return null;
}
