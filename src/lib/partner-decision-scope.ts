// partner-decision-scope — Fix pack 7 (P2): the ONE routing key for who decides a hold or a
// KYC case. Pure and client-safe. Runtime import: ./live-certified only; types from ./types.
//
// A signed posture alone changes nothing: any non-default partner admin with two-step sign-in
// can sign one, so every routing predicate also needs a standing live certification
// (isLiveCertified), which nobody can hold before pack 9. Callers that need the owner treat a
// failed or null owner read as a REFUSAL (generic not-allowed), never as "not certified": that
// would reopen the platform path (P2). Callers re-check isQualifiedComplianceUser at decide
// time with a fresh staff read and staffMfaEnrolled, which fails closed. The written
// delegation of Q-R05.3 is holdDecider 'smartremit_delegated', with no new field.

import { isLiveCertified } from './live-certified';
import type { Partner, PartnerId, StaffRole } from './types';

export type ScopeOwner = Pick<Partner, 'id' | 'status' | 'kycMode' | 'liveControls'>;

/** A hold of this owner gets an append-only review record: the owner is certified for live money. */
export function reviewRecordApplies(owner: ScopeOwner | null | undefined): boolean {
  return isLiveCertified(owner);
}

/** The owner's own compliance staff decide its holds (certified, posture holdDecider 'partner'). */
export function holdQueueApplies(owner: ScopeOwner | null | undefined): boolean {
  return isLiveCertified(owner) && owner?.liveControls?.posture?.holdDecider === 'partner';
}

/** The owner delegated its hold decisions to SmartRemit in writing (holdDecider 'smartremit_delegated'). */
export function platformDelegated(owner: ScopeOwner | null | undefined): boolean {
  return isLiveCertified(owner) && owner?.liveControls?.posture?.holdDecider === 'smartremit_delegated';
}

/** The owner decides KYC: certified, posture kycDecider 'partner' AND kycMode 'delegated' (a disagreeing posture is false). */
export function partnerDecidesKyc(owner: ScopeOwner | null | undefined): boolean {
  return isLiveCertified(owner) && owner?.liveControls?.posture?.kycDecider === 'partner' && owner?.kycMode === 'delegated';
}

export interface ComplianceStaffFact { username: string; partnerId?: PartnerId | null; role: StaffRole; active: boolean }

/**
 * A qualified compliance user of this owner: listed in liveControls.complianceUsers, this
 * tenant's staff, an admin or agent, active and MFA-enrolled. Does not check certification:
 * callers combine it with a routing predicate. liveReadiness uses it too (the rule exists once).
 */
export function isQualifiedComplianceUser(
  owner: Pick<Partner, 'id' | 'liveControls'> | null | undefined,
  staff: ComplianceStaffFact | null | undefined,
  mfaEnrolled: boolean,
): boolean {
  return !!owner && !!staff
    && (owner.liveControls?.complianceUsers ?? []).includes(staff.username)
    && staff.partnerId === owner.id
    && (staff.role === 'admin' || staff.role === 'agent')
    && staff.active === true
    && mfaEnrolled === true;
}
