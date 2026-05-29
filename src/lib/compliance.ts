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
  sourceCountry?: CountryCode;       // NEW (P5) — passed to the screener for jurisdiction scoping
  rules?: ResolvedCorridorRules;     // NEW (P5) — defaults to GLOBAL_DEFAULTS (today's values)
  screener?: SanctionsScreener;      // NEW (P5) — defaults to a mock over rules' base ∪ extra
}): Promise<ComplianceResult> {
  const rules = input.rules ?? GLOBAL_DEFAULTS;
  const screener =
    input.screener ??
    getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra]);

  const hit = await screener.screen({
    name: input.recipientName ?? '',
    sourceCountry: input.sourceCountry ?? 'US',
  });
  if (hit.matched) {
    return {
      status: 'blocked',
      reasons: ['Recipient is on the compliance watchlist.'],
    };
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
