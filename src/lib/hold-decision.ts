// hold-decision — Fix pack 7 (P7, P13): the decision reason and the evidence
// bounds of a hold decision. SERVER-ONLY (no 'use server': these are helpers,
// not actions): isPartnerNoteShaped lives in partner-transfers.ts, which
// reaches node:crypto, and PURPOSE_RISK_CATEGORIES reaches node:url. No
// 'use client' file may import this module.
//
// The decision reason is the ONE free text of pack 7. It is bounded, and
// stored only in `hold_reviews.reason` and in audit meta `reason`. It never
// enters an event, an alert, a log line, an outbox payload or DETAIL_KEYS.
// Known limit: it is not sealed, like audit meta reasons.
//
// T10 adds `decideHold` here.
import type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { AML_HOLD_RULES } from './aml-rules';
import { isPartnerNoteShaped } from './partner-transfers';
import { PURPOSE_RISK_CATEGORIES } from './purpose-detail';
import { RISK_SIGNALS } from './risk-signals';
import { requireStaffReason, STAFF_REASON_MAX, STAFF_REASON_MIN } from './send-limits';
import { isReasonValid } from './ui/confirm-reason';

export const HOLD_REASON_MIN = STAFF_REASON_MIN;
export const HOLD_REASON_MAX = STAFF_REASON_MAX;

/**
 * P7: the decision reason, for BOTH scopes. The exact sequence of the partner
 * release action (release-actions.ts): the client rule (code points after
 * collapsing spaces), then the server rule (bounded, control characters
 * collapsed, at least 10, cut at 500), then no long digit run.
 */
export function parseHoldReason(raw: unknown): { ok: true; reason: string } | { ok: false; code: 'short' | 'number' } {
  if (!isReasonValid(raw, STAFF_REASON_MIN)) return { ok: false, code: 'short' };
  let reason: string;
  try {
    reason = requireStaffReason(raw);
  } catch {
    return { ok: false, code: 'short' };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, code: 'number' };
  return { ok: true, reason };
}

/** P7: at most this many entries per evidence list. */
export const HOLD_EVIDENCE_LIST_MAX = 20;
const TEXT_MAX = 128;
/** A list entry id (`<prefix>:<uid>`), P7: at most 64 characters. */
const ENTRY_ID_RE = /^[A-Za-z0-9._:#/-]{1,64}$/;
type AmlKind = NonNullable<HoldReviewEvidence['amlKinds']>[number];
const AML_KINDS: readonly AmlKind[] = Object.freeze(['aml_rule', 'aml_check_failed', 'scam_pattern', 'risk_signal'] as const);

function closedList<T extends string>(v: unknown, allowed: (s: string) => boolean): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !allowed(x) || out.includes(x as T)) continue;
    out.push(x as T);
    if (out.length >= HOLD_EVIDENCE_LIST_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

function text(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return v.slice(0, TEXT_MAX);
}

/**
 * P7: the evidence stored with a decision: ids, versions, scores and closed
 * enums only. Known keys only; every list is intersected with its closed set
 * (or the id shape), de-duplicated, kept in order and capped at 20. Anything
 * else (a hash, a name, a phone, an unknown key) is dropped.
 */
export function boundHoldEvidence(e: unknown): HoldReviewEvidence {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return {};
  const src = e as Record<string, unknown>;
  const out: HoldReviewEvidence = {};
  const listSource = text(src.listSource);
  if (listSource !== undefined) out.listSource = listSource;
  const listVersion = text(src.listVersion);
  if (listVersion !== undefined) out.listVersion = listVersion;
  // Kept as its ISO form (bounded and canonical; an ISO input is unchanged).
  if (typeof src.screenedAt === 'string' && Number.isFinite(Date.parse(src.screenedAt))) out.screenedAt = new Date(Date.parse(src.screenedAt)).toISOString();
  if (typeof src.maxScore === 'number' && Number.isFinite(src.maxScore) && src.maxScore >= 0 && src.maxScore <= 1) out.maxScore = src.maxScore;
  const ids = closedList<string>(src.matchedEntryIds, (s) => ENTRY_ID_RE.test(s));
  if (ids) out.matchedEntryIds = ids;
  const kinds = closedList<AmlKind>(src.amlKinds, (s) => (AML_KINDS as readonly string[]).includes(s));
  if (kinds) out.amlKinds = kinds;
  const rules = closedList<string>(src.amlRules, (s) => (AML_HOLD_RULES as readonly string[]).includes(s));
  if (rules) out.amlRules = rules;
  const signals = closedList<string>(src.riskSignals, (s) => (RISK_SIGNALS as readonly string[]).includes(s));
  if (signals) out.riskSignals = signals;
  if (typeof src.scamCategory === 'string' && (PURPOSE_RISK_CATEGORIES as readonly string[]).includes(src.scamCategory)) {
    out.scamCategory = src.scamCategory;
  }
  return out;
}
