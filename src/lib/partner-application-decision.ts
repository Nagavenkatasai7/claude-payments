// partner-application-decision — the pure rules behind the staff decision on
// a submitted partner application (Program-Fix 49C, partner-02). They live here
// rather than in partner-requests/actions.ts because a 'use server' module may
// export only async functions, and the detail page and the wizard need them too.
//
// Lifecycle (partner_requests.application_status, free text, no CHECK):
//   invited   → the emailed single-use link is live
//   completed → the applicant submitted the form (link dead)
//   approved | rejected → a platform admin decided (link dead, token hash cleared)
// Only an 'invited' row may use the link; only a 'completed' row may be decided.

import type { PartnerApplicationStatus } from './types';

export type ApplicationDecision = Extract<PartnerApplicationStatus, 'approved' | 'rejected'>;

/** Staff-written reason, stored only in the audit row. */
export const DECISION_REASON_MAX = 500;

const PREQ_ID = /^preq_[A-Za-z0-9_-]{1,64}$/;

export function isPartnerRequestId(id: string): boolean {
  return PREQ_ID.test(id);
}

/** A decision is allowed only on a submitted application: completed → approved|rejected. */
export function canDecideApplication(status: string | undefined): boolean {
  return status === 'completed';
}

/** Trimmed, bounded reason; null when blank (a decision needs a reason). */
export function parseDecisionReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const reason = raw.trim().slice(0, DECISION_REASON_MAX);
  return reason ? reason : null;
}

const NAME_MAX = 120;

/**
 * The partner wizard's starting values for an approved lead: the company name,
 * and the lead's corridors narrowed to the countries the wizard offers as
 * SOURCE countries (a lead's corridor list mixes sources, destinations and
 * "Other"). Falls back to US, the wizard's own default.
 */
export function wizardPrefillFromRequest<C extends string>(
  request: { companyName: string; corridors: string[] },
  allowedCountries: readonly C[],
): { name: string; countries: C[] } {
  const countries = allowedCountries.filter((c) => request.corridors.includes(c));
  return {
    name: request.companyName.trim().slice(0, NAME_MAX),
    countries: countries.length > 0 ? countries : (allowedCountries.includes('US' as C) ? ['US' as C] : []),
  };
}
