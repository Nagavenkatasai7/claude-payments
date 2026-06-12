import type { DbOrTx } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import type { PartnerIntegrationsStore } from './partner-integrations-store';
import type { CurrencyCode, PartnerRate, SettlementRoute } from './types';
import { DEFAULT_PARTNER_ID } from './defaults';

// partner-rates — best-rate selection (internal). The platform mid-market rate
// is ALWAYS the baseline competitor; an eligible partner wins a corridor only
// by being STRICTLY better for the customer (more destination units per source
// unit). Zero competitors ⇒ today's behavior byte-for-byte: mid-market rate,
// settle via the customer's own partner. The customer never sees the routing.
//
// Eligibility (all required):
//   • partner row ACTIVE (enforced in the repo's candidate join)
//   • not the 'default' partner (it IS the platform baseline)
//   • a FRESH pushed rate (effectiveRate with expiresAt in the future), else a
//     standing marginBps off mid (signed; positive ⇒ better for the customer)
//   • a routable rail: payment.providerType 'http' | 'simulator' AND a
//     non-empty credentials.settlementUrl — anything else dead-letters money
//     in `paid` (the settlement.instruct handler throws on a missing URL).
//
// Callers gate on the tenant BEFORE calling (white-label customers are pinned
// to their partner — transmitter of record): only default-tenant quotes route.

const ROUTABLE_PROVIDER_TYPES = new Set(['http', 'simulator']);

/**
 * The rate a partner is offering for a corridor right now, or null when it
 * isn't competing. Pure — freshness is judged against the passed `now`.
 */
export function effectiveRateFor(rate: PartnerRate, mid: number, now: Date): number | null {
  if (
    rate.effectiveRate !== undefined &&
    rate.effectiveRate > 0 &&
    rate.expiresAt !== undefined &&
    Date.parse(rate.expiresAt) > now.getTime()
  ) {
    return rate.effectiveRate;
  }
  if (rate.marginBps !== undefined && Number.isFinite(rate.marginBps)) {
    return mid * (1 + rate.marginBps / 10_000);
  }
  return null;
}

/**
 * Pick the settlement route for one corridor: the best STRICTLY-better-than-mid
 * eligible partner, else the platform default. Integrations are fetched only
 * for provisional winners (descending), so the hot quote path does one indexed
 * query + at most a couple of integrations reads.
 */
export async function selectSettlementRoute(
  db: DbOrTx,
  integrationsStore: PartnerIntegrationsStore,
  sourceCurrency: CurrencyCode,
  destinationCurrency: CurrencyCode,
  mid: number,
  now: Date = new Date(),
): Promise<SettlementRoute> {
  const platform: SettlementRoute = { fxRate: mid, source: 'platform' };
  if (!Number.isFinite(mid) || mid <= 0) return platform;

  let candidates: PartnerRate[];
  try {
    candidates = await createPartnerRateRepo(db).listCandidatesForCorridor(
      sourceCurrency,
      destinationCurrency,
    );
  } catch (err) {
    // Selection is an optimization, never a blocker — a rates outage must not
    // take quoting down. Fall back to the platform rate.
    console.warn('selectSettlementRoute: candidate query failed:', err instanceof Error ? err.message : err);
    return platform;
  }

  const contenders = candidates
    .filter((r) => r.partnerId !== DEFAULT_PARTNER_ID)
    .map((r) => ({ partnerId: r.partnerId, fxRate: effectiveRateFor(r, mid, now) }))
    .filter((c): c is { partnerId: string; fxRate: number } => c.fxRate !== null && c.fxRate > mid)
    .sort((a, b) => b.fxRate - a.fxRate);

  for (const c of contenders) {
    try {
      const integrations = await integrationsStore.getIntegrations(c.partnerId);
      const providerType = integrations.payment.providerType ?? '';
      const settlementUrl = integrations.payment.credentials?.settlementUrl ?? '';
      if (ROUTABLE_PROVIDER_TYPES.has(providerType) && settlementUrl.trim() !== '') {
        return { fxRate: c.fxRate, source: 'partner', settlementPartnerId: c.partnerId };
      }
    } catch (err) {
      console.warn(
        `selectSettlementRoute: integrations read failed for ${c.partnerId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Not routable — fall through to the next-best contender.
  }
  return platform;
}
