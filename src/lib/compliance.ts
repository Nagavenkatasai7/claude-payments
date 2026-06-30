import type { ComplianceStatus, CountryCode } from './types';
import {
  type ResolvedCorridorRules,
  GLOBAL_DEFAULTS,
} from './compliance-config';
import {
  type SanctionsScreener,
  getSanctionsScreener,
} from './providers/sanctions-provider';

// Re-export the canonical screening constants so existing importers keep working
// without changing their import paths (compliance-config is now the source of truth).
export { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from './compliance-config';

export interface ComplianceResult {
  status: ComplianceStatus;
  reasons: string[];
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

  const recipientHit = await screener.screen({ name: input.recipientName ?? '', sourceCountry });
  const senderHit = input.senderName
    ? await screener.screen({ name: input.senderName ?? '', sourceCountry })   // NEW (KYC)
    : { matched: false };
  if (recipientHit.matched || senderHit.matched) {
    const blockReasons: string[] = [];
    if (recipientHit.matched) blockReasons.push('Recipient is on the compliance watchlist.');
    if (senderHit.matched)    blockReasons.push('Sender is on the compliance watchlist.');
    return { status: 'blocked', reasons: blockReasons };
  }

  const reasons: string[] = [];
  if (input.amountUsd >= rules.largeAmountUsd) {
    reasons.push('Large transfer amount.');
  }
  if (input.transfersToday >= rules.velocityLimit) {
    reasons.push('High transfer velocity.');
  }
  if (reasons.length > 0) return { status: 'flagged', reasons };
  return { status: 'cleared', reasons: [] };
}
