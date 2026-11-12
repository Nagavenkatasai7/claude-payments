// partner-kyc-decision — Fix pack 7 (P22, T24): what a KYC decision of a partner that decides KYC
// (partnerDecidesKyc) must carry, parsed from its form and re-checked before an audit write.
//
// SERVER-ONLY: isPartnerNoteShaped lives in partner-transfers.ts, which imports node:crypto. No
// 'use client' file and no client import-chain root (partner-reviews.ts, compliance-config.ts) may
// import this module. The types and KYC_DISPOSITIONS stay in the client-safe partner-reviews.ts.
//
// Rules: a FLAGGED approve needs disposition false_positive or pep_accepted_with_edd, a flagged
// reject needs 'reject', pep_accepted_with_edd needs the "EDD completed" tick; an UNFLAGGED decision
// drops a posted disposition. The EDD note (bounded, never number-shaped) is kept only with the
// tick. Unknown keys are dropped. Nothing here is logged.

import { isPartnerNoteShaped } from './partner-transfers';
import { isKycDisposition, type KycDecision, type KycDecisionExtraMeta } from './partner-reviews';

export const KYC_EDD_NOTE_MAX = 280;

// Fix pack 7 T27 (P25): the platform side of a partner that decides KYC. The fixed refusal texts of
// the admin customer actions live here because a 'use server' module may export only guarded
// actions (tests/site-host-guard.test.ts). English literals: the admin dashboard is not localized.
/** A SmartRemit platform admin tries to decide KYC for a customer of a partner that decides it. */
export const PARTNER_DECIDES_KYC_REFUSAL = 'This partner decides KYC for its customers: record a recommendation instead.';
/** Partner-scoped staff on /admin-dashboard (unreachable in production: requireStaff redirects them). */
export const PARTNER_WORKSPACE_KYC_REFUSAL = 'Decide this customer in your partner workspace.';
/** A create already verified or grandfathered for a partner that decides KYC. */
export const PARTNER_CREATE_KYC_REFUSAL = 'This partner decides KYC: create the customer with KYC not started.';
/** The platform clear of a PEP-only sender hold of a partner that decides KYC. */
export const PARTNER_PEP_CLEAR_REFUSAL = 'This partner decides this PEP flag: record a recommendation instead.';
/** A recommendation for a customer of a partner that does not decide KYC (SmartRemit decides there). */
export const KYC_RECOMMENDATION_ONLY_REFUSAL = 'Recommendations are only for a partner that decides KYC.';
/** A recommendation other than approve or reject. */
export const KYC_RECOMMENDATION_INVALID = 'Invalid recommendation.';

export type KycExtraMetaCode = 'disposition' | 'edd_required' | 'note_long' | 'note_number';

type NoteCheck = { ok: true; note: string | undefined } | { ok: false; code: 'note_long' | 'note_number' };

function checkNote(raw: unknown): NoteCheck {
  if (typeof raw !== 'string') return { ok: true, note: undefined };
  const note = raw.trim();
  if (note === '') return { ok: true, note: undefined };
  if (note.length > KYC_EDD_NOTE_MAX) return { ok: false, code: 'note_long' };
  if (!isPartnerNoteShaped(note)) return { ok: false, code: 'note_number' };
  return { ok: true, note };
}

/** Parses the closed extra fields (disposition, eddDone, eddNote) of a partner KYC decision form. */
export function parseKycExtraMeta(
  fd: FormData,
  decision: KycDecision,
  flagged: boolean,
): { ok: true; meta: KycDecisionExtraMeta } | { ok: false; code: KycExtraMetaCode } {
  const meta: KycDecisionExtraMeta = {};
  const eddRaw = fd.get('eddDone');
  const eddDone = eddRaw === 'on' || eddRaw === 'true';
  if (flagged) {
    const d = fd.get('disposition');
    if (!isKycDisposition(d)) return { ok: false, code: 'disposition' };
    if (decision === 'approve' ? d === 'reject' : d !== 'reject') return { ok: false, code: 'disposition' };
    if (d === 'pep_accepted_with_edd' && !eddDone) return { ok: false, code: 'edd_required' };
    meta.disposition = d;
  }
  if (eddDone) {
    meta.eddDone = true;
    const n = checkNote(fd.get('eddNote'));
    if (!n.ok) return { ok: false, code: n.code };
    if (n.note !== undefined) meta.eddNote = n.note;
  }
  return { ok: true, meta };
}

/** Defence in depth before an audit write: keeps only the closed keys within the same bounds. */
export function sanitizeKycExtraMeta(raw: unknown): KycDecisionExtraMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: KycDecisionExtraMeta = {};
  if (Object.hasOwn(r, 'disposition') && isKycDisposition(r.disposition)) out.disposition = r.disposition;
  if (Object.hasOwn(r, 'eddDone') && r.eddDone === true) {
    out.eddDone = true;
    const n = Object.hasOwn(r, 'eddNote') ? checkNote(r.eddNote) : null;
    if (n?.ok && n.note !== undefined) out.eddNote = n.note;
  }
  return out;
}
