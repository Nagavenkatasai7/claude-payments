// hold-queue — Fix pack 7 (P4, D2): the hold classes of a held transfer and
// their fingerprints.
//
// PURE and client-safe: its runtime import is ./compliance-config only
// (tests/client-import-chain.test.ts lists it as a root). The registry
// (HOLD_REASONS) is not changed here (pack 2 pins it): a new HOLD_REASONS
// entry fails the coverage test in tests/hold-queue.test.ts until it is
// classified on purpose. Sanctions possible matches and watchlist hits are
// SmartRemit's (Q1). LIST_UNAVAILABLE lifts only by the worker re-screen.
// Data-missing holds wait for the data.
import {
  AML_HOLD_REASON, EDD_REQUIRED_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON,
  ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON, RECIPIENT_IDENTITY_MISSING_REASON,
  RECIPIENT_WATCHLIST_REASON, SENDER_IDENTITY_MISSING_REASON, SENDER_SCREENING_REASON,
  SENDER_WATCHLIST_REASON, VELOCITY_REASON, senderScreeningHoldActive, type CustomerScreeningFlags,
} from './compliance-config';

export const HOLD_CLASSES = Object.freeze([
  'kyc', 'aml', 'sender_pep', 'sanctions_review', 'sender_watchlist', 'list_wait', 'data_missing', 'blocked', 'unknown',
] as const);
export type HoldClass = (typeof HOLD_CLASSES)[number];
export type HoldDecider = 'partner' | 'platform' | 'nobody';
export interface ClassifiedClass { holdClass: HoldClass; reasons: readonly string[]; decider: HoldDecider }
/** From P2 (partner-decision-scope.ts), computed by the caller. */
export interface ClassifyOwner { queue: boolean; partnerDecidesKyc: boolean }

export function isHoldClass(v: unknown): v is HoldClass {
  return typeof v === 'string' && (HOLD_CLASSES as readonly string[]).includes(v);
}

/** Every HOLD_REASONS key, mapped to its class ('sender' splits by the sender flags). */
export const REASON_CLASS: Readonly<Record<string, HoldClass | 'sender'>> = Object.freeze({
  [LARGE_AMOUNT_REASON]: 'kyc', [VELOCITY_REASON]: 'kyc', [EDD_REQUIRED_REASON]: 'kyc',
  [AML_HOLD_REASON]: 'aml',
  [SENDER_SCREENING_REASON]: 'sender',
  [POSSIBLE_MATCH_REASON]: 'sanctions_review', [SENDER_IDENTITY_MISSING_REASON]: 'sanctions_review',
  [LIST_UNAVAILABLE_REASON]: 'list_wait',
  [RECIPIENT_IDENTITY_MISSING_REASON]: 'data_missing', [ORIGINATOR_INFO_MISSING_REASON]: 'data_missing',
  [RECIPIENT_WATCHLIST_REASON]: 'blocked', [SENDER_WATCHLIST_REASON]: 'blocked',
} satisfies Record<string, HoldClass | 'sender'>);

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/**
 * P4 (R2): THE PEP-only rule (classifyHold, partnerKycFlag, the KYC store,
 * clearPepInTx). FAIL CLOSED: `screeningWatchlistAt === undefined` (the
 * column was not read) is never PEP-only; a watchlist stamp counts unless a
 * readable clear is strictly later than it (a tie or an unreadable time stays
 * a watchlist hit).
 */
export function senderPepOnly(flags: CustomerScreeningFlags | null | undefined): boolean {
  if (!flags || flags.pepHit !== true || flags.watchlistHit === true) return false;
  const wl = flags.screeningWatchlistAt;
  if (wl === undefined) return false;
  if (wl === null) return true;
  const cleared = flags.screeningClearedAt ?? null;
  if (cleared == null) return false;
  const c = toMs(cleared);
  const w = toMs(wl);
  return Number.isFinite(c) && Number.isFinite(w) && c > w;
}

function senderClass(flags: CustomerScreeningFlags | null | undefined): HoldClass {
  return senderPepOnly(flags) ? 'sender_pep' : 'sender_watchlist';
}

function deciderOf(c: HoldClass, owner: ClassifyOwner, dataOnFile: boolean): HoldDecider {
  switch (c) {
    case 'kyc':
    case 'aml':
      return owner.queue ? 'partner' : 'platform';
    case 'sender_pep':
      return owner.queue && owner.partnerDecidesKyc ? 'partner' : 'platform'; // DP3
    case 'data_missing':
      return dataOnFile ? 'platform' : 'nobody'; // P5 rule 4
    case 'list_wait':
    case 'blocked':
      return 'nobody';
    case 'sanctions_review':
    case 'sender_watchlist':
    case 'unknown':
      return 'platform';
  }
}

/**
 * P4: the classes of a held row, one entry per present class in HOLD_CLASSES
 * order, reasons sorted (code-unit order) and de-duplicated; output frozen.
 * `senderFlags`: undefined = not read, null = the read failed (fail closed:
 * a sender class reads as sender_watchlist, and with no SENDER_SCREENING
 * reason a synthetic sender_watchlist is added, R1). A read stamp that landed
 * after the hold adds a synthetic sender class with reasons [] (R1).
 */
export function classifyHold(
  reasons: readonly unknown[] | null | undefined,
  senderFlags: CustomerScreeningFlags | null | undefined,
  owner: ClassifyOwner,
  opts?: { blocked?: boolean; dataOnFile?: boolean },
): ClassifiedClass[] {
  const found = new Map<HoldClass, Set<string>>();
  const add = (c: HoldClass, r?: string) => {
    let s = found.get(c);
    if (!s) found.set(c, (s = new Set()));
    if (r !== undefined) s.add(r);
  };
  const list: readonly unknown[] = Array.isArray(reasons) ? reasons : [];
  if (list.length === 0) add('unknown');
  let senderReason = false;
  for (const r of list) {
    if (typeof r !== 'string') { add('unknown'); continue; }
    const k = Object.hasOwn(REASON_CLASS, r) ? REASON_CLASS[r] : undefined;
    if (k === undefined) add('unknown', r);
    else if (k === 'sender') { senderReason = true; add(senderClass(senderFlags), r); }
    else add(k, r);
  }
  if (!senderReason && senderFlags !== undefined) {
    // null: the read failed, so a later stamp cannot be ruled out (fail closed).
    if (senderFlags === null || senderScreeningHoldActive(senderFlags) || senderFlags.watchlistHit === true) {
      add(senderClass(senderFlags));
    }
  }
  if (opts?.blocked === true) add('blocked');
  const dataOnFile = opts?.dataOnFile === true;
  const out: ClassifiedClass[] = [];
  for (const c of HOLD_CLASSES) {
    const s = found.get(c);
    if (!s) continue;
    out.push(Object.freeze({ holdClass: c, reasons: Object.freeze([...s].sort()), decider: deciderOf(c, owner, dataOnFile) }));
  }
  return Object.freeze(out) as ClassifiedClass[];
}

const FP_MAX = 1000;
const esc = (r: string) => r.replaceAll('%', '%25').replaceAll('|', '%7C');
function bounded(fp: string): string {
  if (fp.length > FP_MAX) throw new RangeError('hold-queue: reasons fingerprint too long');
  return fp;
}

/**
 * Fix pack 7 T16 (P4, P14; C4, M8, P3, R1): does the row carry a SANCTIONS hold?
 * sanctions_review, sender_watchlist (incl. the synthetic class from a later
 * stamp and unreadable flags, fail closed) and blocked. A PEP-only sender
 * (sender_pep) is NOT one. The funds rule (D7) keys on this on real money.
 */
export function hasSanctionsHold(classes: readonly ClassifiedClass[]): boolean {
  return classes.some((c) => c.holdClass === 'sanctions_review' || c.holdClass === 'sender_watchlist' || c.holdClass === 'blocked');
}

/**
 * P4: the whole row's reasons fingerprint (the value the decision dialog
 * posts). No hash: reasons are code constants. String entries only, unique,
 * sorted, escaped (`%` -> `%25`, `|` -> `%7C`, the identity for every registry
 * reason). Throws RangeError above 1000 characters (callers refuse).
 */
export function rowReasonsFp(reasons: readonly unknown[] | null | undefined): string {
  const strs = Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [];
  return bounded('v1|' + [...new Set(strs)].sort().map(esc).join('|'));
}

function isoOrDash(v: string | Date | null | undefined): string {
  if (v == null) return '-';
  const ms = toMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '-';
}

/**
 * P4: one class's fingerprint (stored in hold_reviews.reasons_fp). A reason
 * added to another class leaves it unchanged. The sender classes also carry
 * `|f=<screeningFlaggedAt ISO or ->` (R5), so a re-armed stamp opens a new
 * review cycle. Throws RangeError above 1000 characters.
 */
export function classReasonsFp(
  c: Pick<ClassifiedClass, 'holdClass' | 'reasons'>,
  flags?: CustomerScreeningFlags | null,
): string {
  let fp = 'v1|' + c.holdClass + '|' + c.reasons.map(esc).join('|');
  if (c.holdClass === 'sender_pep' || c.holdClass === 'sender_watchlist') fp += '|f=' + isoOrDash(flags?.screeningFlaggedAt);
  return bounded(fp);
}

// ── Decisions (T6: P5 rules 1-9, DP4, DP12) ─────────────────────────────────

/** P5: the closed disposition list (14). DRAFT for counsel and the owner. */
export const HOLD_DISPOSITIONS = Object.freeze([
  'documents_verified', 'activity_explained', 'customer_not_verified', 'activity_unexplained', 'false_positive',
  'suspicious_activity', 'scam_suspected', 'pep_accepted_with_edd', 'pep_rejected', 'false_positive_match',
  'confirmed_match', 'unable_to_clear', 'data_received', 'data_not_provided',
] as const);
export type HoldDisposition = (typeof HOLD_DISPOSITIONS)[number];
export type HoldScope = 'partner' | 'platform';

export function isHoldDisposition(v: unknown): v is HoldDisposition {
  return typeof v === 'string' && (HOLD_DISPOSITIONS as readonly string[]).includes(v);
}

type Lists = { readonly release: readonly HoldDisposition[]; readonly reject: readonly HoldDisposition[] };
const lists = (release: readonly HoldDisposition[], reject: readonly HoldDisposition[]): Lists =>
  Object.freeze({ release: Object.freeze([...release]), reject: Object.freeze([...reject]) });
const NONE = lists([], []);
const KYC_LISTS = lists(['documents_verified', 'activity_explained'], ['customer_not_verified', 'activity_unexplained']);
const AML_LISTS = lists(['false_positive', 'activity_explained'], ['suspicious_activity', 'scam_suspected']);
const PEP_LISTS = lists(['pep_accepted_with_edd', 'false_positive'], ['pep_rejected']);
const SANCTIONS_LISTS = lists(['false_positive_match'], ['confirmed_match', 'unable_to_clear']);

/**
 * DRAFT lists for counsel and the owner (P5); same lists for both scopes where
 * both may decide. The platform-only classes give the partner nothing. A
 * data_missing release (`data_received`) is still refused by rule 4 until the
 * class's decider is platform (P4 `dataOnFile`).
 */
const DISPOSITION_TABLE: Readonly<Record<HoldClass, Readonly<{ partner: Lists; platform: Lists }>>> = Object.freeze({
  kyc: Object.freeze({ partner: KYC_LISTS, platform: KYC_LISTS }),
  aml: Object.freeze({ partner: AML_LISTS, platform: AML_LISTS }),
  sender_pep: Object.freeze({ partner: PEP_LISTS, platform: PEP_LISTS }),
  sanctions_review: Object.freeze({ partner: NONE, platform: SANCTIONS_LISTS }),
  sender_watchlist: Object.freeze({ partner: NONE, platform: SANCTIONS_LISTS }),
  unknown: Object.freeze({ partner: NONE, platform: SANCTIONS_LISTS }),
  data_missing: Object.freeze({ partner: NONE, platform: lists(['data_received'], ['data_not_provided']) }),
  list_wait: Object.freeze({ partner: NONE, platform: lists([], ['unable_to_clear']) }), // M11, DP12
  blocked: Object.freeze({ partner: NONE, platform: lists([], ['confirmed_match']) }),
});

export function allowedDispositions(
  holdClass: HoldClass,
  scope: HoldScope,
): { release: readonly HoldDisposition[]; reject: readonly HoldDisposition[] } {
  return DISPOSITION_TABLE[holdClass][scope];
}

const RELEASING: ReadonlySet<HoldDisposition> = new Set<HoldDisposition>([
  'documents_verified', 'activity_explained', 'false_positive', 'pep_accepted_with_edd', 'false_positive_match', 'data_received',
]);

/** True when the disposition releases its class; every other disposition rejects. */
export function dispositionReleases(d: HoldDisposition): boolean {
  return RELEASING.has(d);
}

/** A hold_reviews row narrowed to the closed unions (decisionRoute's input). */
export interface ReviewRowLite {
  holdClass: HoldClass;
  reasonsFp: string;
  step: 1 | 2;
  final: boolean;
  disposition: HoldDisposition;
  actor: string;
  actorScope: HoldScope;
  createdAt: string;
}

/**
 * Narrows a stored row (hold-review-repo's HoldReviewRow, structurally: this
 * module never imports the repo). Null on an unknown hold_class or
 * disposition string (the DB has no CHECK on either).
 */
export function toReviewRowLite(r: {
  holdClass: string; reasonsFp: string; step: 1 | 2; final: boolean; disposition: string;
  actor: string; actorScope: HoldScope; createdAt: string;
}): ReviewRowLite | null {
  if (!isHoldClass(r.holdClass) || !isHoldDisposition(r.disposition)) return null;
  return {
    holdClass: r.holdClass, reasonsFp: r.reasonsFp, step: r.step, final: r.final, disposition: r.disposition,
    actor: r.actor, actorScope: r.actorScope, createdAt: r.createdAt,
  };
}

export type NextStep = { step: 1 | 2; final: boolean } | { refused: 'closed' | 'same_actor' };

/**
 * P5 rule 8: the next step of ONE class's cycle (its rows under its current
 * classReasonsFp). A final row closes the cycle; an open step 1 always needs
 * a step 2 by another actor, even when fourEyes was switched off since (and
 * even when its actor has since left complianceUsers: rule 9, R8, a known
 * limit, owner question 10). Otherwise a release with fourEyes is an open
 * step 1, and everything else one final step 1.
 */
export function nextStep(cycle: readonly ReviewRowLite[], actor: string, d: HoldDisposition, fourEyes: boolean): NextStep {
  if (cycle.some((r) => r.final)) return { refused: 'closed' };
  const open = cycle.find((r) => r.step === 1 && !r.final);
  if (open) return open.actor === actor ? { refused: 'same_actor' } : { step: 2, final: true };
  return fourEyes && dispositionReleases(d) ? { step: 1, final: false } : { step: 1, final: true };
}

/**
 * P4 (T14a; T17 and T39 reuse it): the classes still open, i.e. with no FINAL
 * review row of the same class under the class's CURRENT classReasonsFp. The
 * sender classes need the flags for their `|f=` part (R5), so a re-armed stamp
 * reopens its class.
 */
export function openHoldClasses(
  classes: readonly ClassifiedClass[],
  reviews: readonly ReviewRowLite[],
  flags?: CustomerScreeningFlags | null,
): ClassifiedClass[] {
  return classes.filter((c) => {
    const fp = classReasonsFp(c, flags);
    return !reviews.some((r) => r.holdClass === c.holdClass && r.final && r.reasonsFp === fp);
  });
}

export type DecisionRefusal =
  | 'not_yours' | 'changed' | 'waits_list' | 'waits_data' | 'waits_platform' | 'blocked' | 'closed' | 'same_actor' | 'disposition';
export type DecisionRoute = { kind: 'record' } | { kind: 'release' } | { kind: 'reject' } | { kind: 'refused'; why: DecisionRefusal };

/** DP4/M11: a nobody-decided data_missing, blocked or list_wait class may be REJECTED by the platform. */
function effectiveDecider(o: ClassifiedClass, kind: 'release' | 'reject'): HoldDecider {
  if (o.decider === 'nobody' && kind === 'reject'
    && (o.holdClass === 'data_missing' || o.holdClass === 'blocked' || o.holdClass === 'list_wait')) return 'platform';
  return o.decider;
}

/**
 * P5 rules 1-8 and DP4: what one posted decision means. The check order is
 * FIXED, so every caller and test sees the same refusal: list_wait (a
 * platform reject stays allowed, rule 3, DP12) -> class absent -> blocked
 * (rule 2) -> effective decider (rule 1) -> disposition -> data_missing
 * release (rule 4) -> partner reject with a non-partner class (rule 5) -> a
 * closed sibling (a final reject) -> nextStep (rule 8; partner four-eyes only,
 * platform four-eyes is pack 9) -> reject (rule 7) / record / release (rule 6:
 * only when every other class has a final releasing row under its CURRENT
 * classReasonsFp).
 *
 * Status in_review, the row fingerprint and complianceStatus are checked by
 * the caller under the row lock (P9 steps 1-2); this function sees classes
 * only. `flags` are the sender flags read under that lock: the sender
 * classes' fingerprints carry their flag time (classReasonsFp `|f=`, R5).
 */
export function decisionRoute(i: {
  classes: readonly ClassifiedClass[];
  reviews: readonly ReviewRowLite[];
  scope: HoldScope;
  holdClass: HoldClass;
  disposition: HoldDisposition;
  actor: string;
  fourEyes: boolean;
  flags?: CustomerScreeningFlags | null;
}): DecisionRoute {
  const refuse = (why: DecisionRefusal): DecisionRoute => ({ kind: 'refused', why });
  const kind = dispositionReleases(i.disposition) ? 'release' : 'reject';
  const platformReject = i.scope === 'platform' && kind === 'reject';
  // 1. list_wait (rule 3, M11, DP12)
  if (!platformReject && i.classes.some((o) => o.holdClass === 'list_wait')) return refuse('waits_list');
  // 2. the posted class
  const c = i.classes.find((o) => o.holdClass === i.holdClass);
  if (!c) return refuse('changed');
  // 4. blocked (rule 2)
  if (!platformReject && i.classes.some((o) => o.holdClass === 'blocked')) return refuse('blocked');
  // 5. effective decider (rule 1, DP4)
  const eff = effectiveDecider(c, kind);
  if (eff === 'nobody') {
    if (c.holdClass === 'data_missing') return refuse('waits_data');
    if (c.holdClass === 'list_wait') return refuse('waits_list');
    return refuse('blocked');
  }
  if (eff !== i.scope) return refuse('not_yours');
  // 6. disposition
  if (!allowedDispositions(c.holdClass, i.scope)[kind].includes(i.disposition)) return refuse('disposition');
  // 7. data_missing release (rule 4)
  if (kind === 'release' && i.classes.some((o) => o.holdClass === 'data_missing' && o.decider === 'nobody')) return refuse('waits_data');
  // 8. partner reject with a non-partner class (rule 5)
  if (i.scope === 'partner' && kind === 'reject'
    && i.classes.some((o) => o !== c && effectiveDecider(o, 'reject') !== 'partner')) return refuse('waits_platform');
  const cycleOf = (o: ClassifiedClass) => {
    const fp = classReasonsFp(o, i.flags);
    return i.reviews.filter((r) => r.holdClass === o.holdClass && r.reasonsFp === fp);
  };
  const others = i.classes.filter((o) => o !== c);
  // 9. a closed sibling (a final reject: the row would already be cancelled)
  if (others.some((o) => cycleOf(o).some((r) => r.final && !dispositionReleases(r.disposition)))) return refuse('closed');
  // 10. the step (rule 8)
  const step = nextStep(cycleOf(c), i.actor, i.disposition, i.fourEyes && i.scope === 'partner');
  if ('refused' in step) return refuse(step.refused);
  // 11-13 (rules 7, 6)
  if (kind === 'reject') return { kind: 'reject' };
  if (!step.final) return { kind: 'record' };
  const allReleased = others.every((o) => cycleOf(o).some((r) => r.final && dispositionReleases(r.disposition)));
  return allReleased ? { kind: 'release' } : { kind: 'record' };
}
