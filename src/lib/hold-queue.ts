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
