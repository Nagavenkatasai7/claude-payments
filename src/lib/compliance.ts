import type { ComplianceStatus, CountryCode } from './types';
import {
  type ResolvedCorridorRules,
  GLOBAL_DEFAULTS,
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
  LARGE_AMOUNT_REASON,
  VELOCITY_REASON,
} from './compliance-config';
import {
  type SanctionsHit,
  type SanctionsScreener,
  getSanctionsScreener,
} from './providers/sanctions-provider';
import { inputHash, type ScreeningEvidence, type ScreeningEvidenceParty, type SanctionsDecision } from './sanctions/evidence';
import { SanctionsListUnavailableError } from './sanctions/list-screener';
import { fromPartialSet, isMultiListScreener } from './sanctions/multi-list-screener';
import { listFitness, type ListFitness } from './sanctions/list-policy';
import { normalizeName } from './sanctions/normalize';
import type { SanctionsListInfo } from './providers/sanctions-provider';

// Re-export the canonical screening constants so existing importers keep working
// without changing their import paths (compliance-config is now the source of truth).
export { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from './compliance-config';
// Program-Fix 43 follow-up: the screening-derived reason constants and the
// predicate that makes such a hold platform-only to release.
export {
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON,
  SENDER_SCREENING_REASON,
  SCREENING_REASONS,
  HOLD_REASONS,
  holdReleasableBy,
  isRescreenOnlyHold,
  isScreeningHold,
  isScreeningCustomerHold,
  canDecideCustomerKyc,
} from './compliance-config';

export interface ComplianceResult {
  status: ComplianceStatus;
  reasons: string[];
  /** Program-Fix 14: what was screened against which list — no names, ever. */
  evidence?: ScreeningEvidence;
}

// The screening reasons (POSSIBLE_MATCH_REASON etc.) live in compliance-config.

function party(role: 'recipient' | 'sender', name: string, hit: SanctionsHit): ScreeningEvidenceParty {
  // matchedName is deliberately NOT copied: the mock's list entries are names.
  const p: ScreeningEvidenceParty = {
    role,
    inputHash: inputHash(name),
    matched: hit.matched,
    matchScore: hit.matchScore ?? (hit.matched ? 1 : 0),
  };
  if ((hit.matched || hit.possibleMatch) && hit.entryId) p.matchedEntryId = hit.entryId;
  return p;
}

/** Fix pack 2 (R02): the list fields of the evidence (fitness, age, base hash). */
function listFields(info: SanctionsListInfo, fitness: ListFitness): Pick<ScreeningEvidence, 'listFitness' | 'listCheckedAt' | 'listBaseHash'> {
  return {
    listFitness: fitness,
    ...(info.checkedAt ? { listCheckedAt: info.checkedAt } : {}),
    ...(info.baseHash ? { listBaseHash: info.baseHash } : {}),
  };
}

/**
 * Fix pack 2 T9 (R02): the further recipient names to screen — each distinct
 * (normalised) non-empty name that is not the primary recipient name, in order.
 */
function extraRecipientNames(recipientName: string, also: readonly string[] | undefined): string[] {
  if (!also || also.length === 0) return [];
  const seen = new Set<string>([normalizeName(recipientName)]);
  const out: string[] = [];
  for (const name of also) {
    if (typeof name !== 'string') continue;
    const key = normalizeName(name);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The amount and velocity flags (not sanctions decisions), in their pinned order. */
function amountVelocityReasons(amountUsd: number, transfersToday: number, rules: ResolvedCorridorRules): string[] {
  const reasons: string[] = [];
  if (amountUsd >= rules.largeAmountUsd) reasons.push(LARGE_AMOUNT_REASON);
  if (transfersToday >= rules.velocityLimit) reasons.push(VELOCITY_REASON);
  return reasons;
}

export async function screenTransfer(input: {
  amountUsd: number;                 // USD-equivalent (unchanged; fed by quote.amountUsd)
  recipientName: string;
  transfersToday: number;
  sourceCountry?: CountryCode;       // P5 — jurisdiction scoping
  rules?: ResolvedCorridorRules;     // P5 — defaults to GLOBAL_DEFAULTS
  screener?: SanctionsScreener;      // P5 — defaults to a mock over rules' base ∪ extra
  senderName?: string;               // NEW (KYC) — sender legal name, screened via the SAME seam
  /**
   * Fix pack 2 (R02): a real-money screen (live-gate.ts realMoneyRail). It
   * clears only on a LIVE list (list-policy.ts: OFAC SDN checked within 36 h);
   * otherwise it is held (flagged, LIST_UNAVAILABLE first). A block still wins.
   */
  requireLiveList?: boolean;
  /** Fix pack 2 (R02): the clock the list age is measured against (default: now). */
  now?: Date;
  /**
   * Fix pack 2 T9 (R02): further names the payee is known by (a payment link's
   * account holder, the stored recipient name). Each distinct non-empty name
   * other than `recipientName` is screened with the same screener as a further
   * 'recipient' party: a match blocks (RECIPIENT_WATCHLIST), a possible match
   * flags (POSSIBLE_MATCH). Absent or empty: the result is exactly today's.
   */
  alsoRecipientNames?: string[];
}): Promise<ComplianceResult> {
  const rules = input.rules ?? GLOBAL_DEFAULTS;
  const screener =
    input.screener ??
    getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra]);
  const sourceCountry = input.sourceCountry ?? 'US';

  const screenedAt = new Date().toISOString();
  const recipientName = input.recipientName ?? '';
  const senderName = input.senderName ?? '';
  const extraNames = extraRecipientNames(recipientName, input.alsoRecipientNames);

  let recipientHit: SanctionsHit;
  let senderHit: SanctionsHit;
  const extraHits: SanctionsHit[] = [];
  // LF1-D1 (lists only): set when any party's screen saw a partial set.
  let partialSet = false;
  try {
    if (isMultiListScreener(screener)) {
      // Fix pack 5 LA1 (SANCTIONS_LIST=lists only): an exact match on any
      // party blocks, even when another party's screen failed closed on a
      // partial list set; that party is recorded unscreened (matched false,
      // score 0). With no exact match anywhere, the hold below runs as before.
      const settle = async (name: string): Promise<SanctionsHit | null> => {
        try {
          return await screener.screen({ name, sourceCountry });
        } catch (err) {
          if (err instanceof SanctionsListUnavailableError) return null;
          throw err;
        }
      };
      const r = await settle(recipientName);
      const s = input.senderName ? await settle(senderName) : { matched: false };
      const ex: Array<SanctionsHit | null> = [];
      for (const name of extraNames) ex.push(await settle(name));
      const all = [r, s, ...ex];
      if (all.some((h) => h === null) && !all.some((h) => h?.matched)) throw new SanctionsListUnavailableError();
      partialSet = all.some((h) => h === null || fromPartialSet(h));
      const unscreenedHit: SanctionsHit = { matched: false, matchScore: 0 };
      recipientHit = r ?? unscreenedHit;
      senderHit = s ?? unscreenedHit;
      for (const h of ex) extraHits.push(h ?? unscreenedHit);
    } else {
      recipientHit = await screener.screen({ name: recipientName, sourceCountry });
      senderHit = input.senderName
        ? await screener.screen({ name: senderName, sourceCountry })   // NEW (KYC)
        : { matched: false };
      for (const name of extraNames) extraHits.push(await screener.screen({ name, sourceCountry }));
    }
  } catch (err) {
    // Program-Fix 14 (B2): a list that cannot load FAILS CLOSED to a human
    // review — never cleared, never the mock, and never a throw that would
    // break every send. Any other screener error propagates as before.
    if (!(err instanceof SanctionsListUnavailableError)) throw err;
    // Fix pack 2 (R02): the amount and velocity flags are kept next to it.
    const info = screener.listInfo();
    const unscreened = (role: 'recipient' | 'sender', name: string): ScreeningEvidenceParty =>
      ({ role, inputHash: inputHash(name), matched: false, matchScore: 0 });
    return {
      status: 'flagged',
      reasons: [LIST_UNAVAILABLE_REASON, ...amountVelocityReasons(input.amountUsd, input.transfersToday, rules)],
      evidence: {
        listSource: info.source,
        listVersion: info.version,
        listHash: info.hash,
        screenedAt,
        decision: 'list_unavailable',
        parties: [
          unscreened('recipient', recipientName),
          ...(input.senderName ? [unscreened('sender', senderName)] : []),
          ...extraNames.map((name) => unscreened('recipient', name)),
        ],
        ...listFields(info, 'not_live'),
      },
    };
  }

  // LF1-D1: a block found on a partial set records that the set was NOT
  // checked (a member may have loaded again before this read).
  const info: SanctionsListInfo = partialSet
    ? { source: screener.listInfo().source, version: 'unavailable', hash: '' }
    : screener.listInfo();
  const fitness = partialSet ? 'not_live' : listFitness(info, input.now ?? new Date());
  const parties = [party('recipient', recipientName, recipientHit)];
  if (input.senderName) parties.push(party('sender', senderName, senderHit));
  extraNames.forEach((name, i) => parties.push(party('recipient', name, extraHits[i])));
  const extraMatch = extraHits.some((h) => h.matched);
  const extraPossible = extraHits.some((h) => Boolean(h.possibleMatch));
  const anyMatch = recipientHit.matched || senderHit.matched || extraMatch;
  const anyPossible = !anyMatch && Boolean(recipientHit.possibleMatch || senderHit.possibleMatch || extraPossible);
  const decision: SanctionsDecision = anyMatch ? 'match' : anyPossible ? 'possible_match' : 'clear';
  const evidence: ScreeningEvidence = {
    listSource: info.source,
    listVersion: info.version,
    listHash: info.hash,
    screenedAt,
    decision,
    parties,
    ...listFields(info, fitness),
  };

  if (anyMatch) {
    const blockReasons: string[] = [];
    if (recipientHit.matched || extraMatch) blockReasons.push(RECIPIENT_WATCHLIST_REASON);
    if (senderHit.matched)    blockReasons.push(SENDER_WATCHLIST_REASON);
    return { status: 'blocked', reasons: blockReasons, evidence };
  }

  // Fix pack 2 (R02): a real-money screen on a list that is not live is held
  // (never cleared): LIST_UNAVAILABLE first, then the usual flags.
  if (input.requireLiveList && fitness !== 'live') {
    return {
      status: 'flagged',
      reasons: [
        LIST_UNAVAILABLE_REASON,
        ...(anyPossible ? [POSSIBLE_MATCH_REASON] : []),
        ...amountVelocityReasons(input.amountUsd, input.transfersToday, rules),
      ],
      evidence: { ...evidence, decision: anyPossible ? 'possible_match' : 'list_unavailable' },
    };
  }

  const reasons: string[] = [];
  if (anyPossible) {
    reasons.push(POSSIBLE_MATCH_REASON);
  }
  reasons.push(...amountVelocityReasons(input.amountUsd, input.transfersToday, rules));
  if (reasons.length > 0) return { status: 'flagged', reasons, evidence };
  return { status: 'cleared', reasons: [], evidence };
}
