// live-certified — Fix pack 7 (DP1): the live certification predicates, client-safe.
// Moved verbatim from live-gate.ts (which re-exports them) so pure client-reached modules
// (partner-decision-scope, compliance-config) can import them. Runtime import: ./defaults only.

import { DEFAULT_PARTNER_ID } from './defaults';
import type { LiveControls } from './live-controls';
import type { Partner } from './types';

export type LivePartner = Pick<Partner, 'id' | 'status' | 'liveControls'> | null | undefined;

/**
 * Certified for live money: an active, non-default partner whose certification
 * is on record and not revoked (a revoke at or after the certification time
 * counts; a later re-certification lifts it). Pure.
 */
export function isLiveCertified(p: LivePartner): boolean {
  if (!p || p.id === DEFAULT_PARTNER_ID || p.status !== 'active') return false;
  const c = p.liveControls?.certification;
  if (!c || Number.isNaN(Date.parse(c.certifiedAt))) return false;
  return hasStandingCertification(p.liveControls);
}

/**
 * A certification record is on file and not revoked: no revokedAt, or a revokedAt strictly
 * before certifiedAt (a later re-certification lifts it; an unparseable stamp counts as revoked).
 * Ignores the partner's status and id: isLiveCertified adds those, the revoke writer and the
 * platform's kycMode lock (pack 3 review Q1) use this alone. Pure.
 */
export function hasStandingCertification(lc: Pick<LiveControls, 'certification'> | null | undefined): boolean {
  const c = lc?.certification;
  if (!c) return false;
  return c.revokedAt === undefined || Date.parse(c.revokedAt) < Date.parse(c.certifiedAt);
}
