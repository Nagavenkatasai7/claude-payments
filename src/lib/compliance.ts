import type { ComplianceStatus, CountryCode } from './types';
import {
  type ResolvedCorridorRules,
  GLOBAL_DEFAULTS,
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
} from './compliance-config';
import {
  type SanctionsHit,
  type SanctionsScreener,
  getSanctionsScreener,
} from './providers/sanctions-provider';
import { inputHash, type ScreeningEvidence, type ScreeningEvidenceParty, type SanctionsDecision } from './sanctions/evidence';
import { SanctionsListUnavailableError } from './sanctions/list-screener';

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
  SCREENING_REASONS,
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

export async function screenTransfer(input: {
  amountUsd: number;                 // USD-equivalent (unchanged; fed by quote.amountUsd)
  recipientName: string;
  transfersToday: number;
  sourceCountry?: CountryCode;       // P5 — jurisdiction scoping
  rules?: ResolvedCorridorRules;     // P5 — defaults to GLOBAL_DEFAULTS
  screener?: SanctionsScreener;      // P5 — defaults to a mock over rules' base ∪ extra
  senderName?: string;               // NEW (KYC) — sender legal name, screened via the SAME seam
}): Promise<ComplianceResult> {
  const rules = input.rules ?? GLOBAL_DEFAULTS;
  const screener =
    input.screener ??
    getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra]);
  const sourceCountry = input.sourceCountry ?? 'US';

  const screenedAt = new Date().toISOString();
  const recipientName = input.recipientName ?? '';
  const senderName = input.senderName ?? '';

  let recipientHit: SanctionsHit;
  let senderHit: SanctionsHit;
  try {
    recipientHit = await screener.screen({ name: recipientName, sourceCountry });
    senderHit = input.senderName
      ? await screener.screen({ name: senderName, sourceCountry })   // NEW (KYC)
      : { matched: false };
  } catch (err) {
    // Program-Fix 14 (B2): a list that cannot load FAILS CLOSED to a human
    // review — never cleared, never the mock, and never a throw that would
    // break every send. Any other screener error propagates as before.
    if (!(err instanceof SanctionsListUnavailableError)) throw err;
    const info = screener.listInfo();
    const unscreened = (role: 'recipient' | 'sender', name: string): ScreeningEvidenceParty =>
      ({ role, inputHash: inputHash(name), matched: false, matchScore: 0 });
    return {
      status: 'flagged',
      reasons: [LIST_UNAVAILABLE_REASON],
      evidence: {
        listSource: info.source,
        listVersion: info.version,
        listHash: info.hash,
        screenedAt,
        decision: 'list_unavailable',
        parties: input.senderName
          ? [unscreened('recipient', recipientName), unscreened('sender', senderName)]
          : [unscreened('recipient', recipientName)],
      },
    };
  }

  const info = screener.listInfo();
  const parties = [party('recipient', recipientName, recipientHit)];
  if (input.senderName) parties.push(party('sender', senderName, senderHit));
  const anyMatch = recipientHit.matched || senderHit.matched;
  const anyPossible = !anyMatch && Boolean(recipientHit.possibleMatch || senderHit.possibleMatch);
  const decision: SanctionsDecision = anyMatch ? 'match' : anyPossible ? 'possible_match' : 'clear';
  const evidence: ScreeningEvidence = {
    listSource: info.source,
    listVersion: info.version,
    listHash: info.hash,
    screenedAt,
    decision,
    parties,
  };

  if (anyMatch) {
    const blockReasons: string[] = [];
    if (recipientHit.matched) blockReasons.push(RECIPIENT_WATCHLIST_REASON);
    if (senderHit.matched)    blockReasons.push(SENDER_WATCHLIST_REASON);
    return { status: 'blocked', reasons: blockReasons, evidence };
  }

  const reasons: string[] = [];
  if (anyPossible) {
    reasons.push(POSSIBLE_MATCH_REASON);
  }
  if (input.amountUsd >= rules.largeAmountUsd) {
    reasons.push('Large transfer amount.');
  }
  if (input.transfersToday >= rules.velocityLimit) {
    reasons.push('High transfer velocity.');
  }
  if (reasons.length > 0) return { status: 'flagged', reasons, evidence };
  return { status: 'cleared', reasons: [], evidence };
}
