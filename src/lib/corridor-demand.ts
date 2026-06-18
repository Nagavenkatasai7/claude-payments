import type { CorridorRequest, CountryCode, CurrencyCode } from './types';
import type { FxRates } from './rate';

// corridor-demand — PURE, deterministic aggregator (no I/O of its own; the FX
// function is injected so tests never touch the network). It turns the raw
// unsupported-destination lead list (CorridorRequest[]) into a RANKED launch
// recommender: per destination, how many leads, how many distinct senders, the
// growth trend, and a best-effort USD-normalized demand figure.
//
// PRIVACY: senderPhone NEVER appears in any output — distinct-sender COUNTS
// only (computed from a hashed-free Set internally, then discarded). The page
// that renders this is platform-only, but the aggregator still refuses to leak
// raw phone numbers by construction.
//
// RANKING: most leads carry no amount (approxAmount/approxCurrency are
// nullable), so USD demand is a SECONDARY signal. The primary rank is lead
// count, then distinct senders, then USD demand, then a stable alphabetical
// tiebreak on the destination key — ties never reorder run-to-run.

/** A function shaped like getFxRates (src/lib/rate.ts) — injected for testability. */
export type FxRatesFn = (source: CurrencyCode) => Promise<FxRates>;

// The currencies the platform actually models. approxCurrency is FREE TEXT (an
// LLM-captured string — "USD", " aed ", "dollars", "rupees"), so we normalize
// it (uppercase + trim) and only attempt an FX conversion for a code in this
// set. Off-enum strings ("dollars", "PKR") stay UNPRICED rather than dialing
// Frankfurter for a currency we can't settle — the lead still counts.
const KNOWN_CURRENCIES = new Set<CurrencyCode>([
  'USD', 'CAD', 'GBP', 'AED', 'SGD', 'AUD', 'NZD', 'INR',
]);

/** Uppercase + trim a free-text currency to a known CurrencyCode, or null. */
function normalizeCurrency(raw: string | undefined | null): CurrencyCode | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return KNOWN_CURRENCIES.has(code as CurrencyCode) ? (code as CurrencyCode) : null;
}

export interface CorridorWindowStats {
  /** Leads captured within the window. */
  leads: number;
  /** Distinct senders within the window (count only — never the numbers). */
  distinctSenders: number;
  /** Sum of USD-normalized approxAmount for rows that HAD an amount+currency. */
  usdDemand: number;
  /** How many leads in the window contributed to usdDemand (had amount+currency). */
  pricedLeads: number;
}

export interface CorridorDemand {
  /** Normalized grouping key (lowercased, trimmed, alias-folded). */
  key: string;
  /** A human-friendly label — the most common raw spelling seen for this key. */
  destination: string;
  /** Whether this destination maps to a country we ALREADY support (gap=false). */
  supported: boolean;
  /** All-time totals across every captured lead for this destination. */
  total: CorridorWindowStats;
  /** Rolling-window slices (default 7 / 30 / 90 days). */
  windows: Record<number, CorridorWindowStats>;
  /**
   * Growth slope: (recent-window leads − prior-equal-window leads). Positive ⇒
   * accelerating demand. Computed on the SHORTEST window by default (e.g. last
   * 7d vs the 7d before that). Null when there isn't a full prior window of
   * history yet (avoids a misleading +N from a cold start).
   */
  growthLeads: number | null;
  /** growthLeads as a percentage of the prior window (null when prior is 0 or unknowable). */
  growthPct: number | null;
}

export interface RankCorridorDemandOptions {
  /** Rolling windows in days, longest-last is not required; sorted internally. Default [7, 30, 90]. */
  windows?: number[];
  /** "Now" anchor for window math. Default Date.now(). Tests pass a fixed value. */
  now?: number;
}

// ── Country-name normalization for the supported-gap flag ────────────────────
//
// Corridor requests store FREE TEXT the user typed ("UAE", "u.k.", "Pakistan").
// Supported corridors are ISO CountryCodes. We fold common aliases of the 8
// supported countries down to their ISO code so a sloppily-typed supported
// country is correctly flagged supported (it shouldn't have been captured, but
// be defensive). Anything we don't recognise is treated as its own unsupported
// destination keyed on its normalized spelling.
const SUPPORTED_ALIASES: Record<string, CountryCode> = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  ca: 'CA', canada: 'CA',
  gb: 'GB', uk: 'GB', 'u.k.': 'GB', 'united kingdom': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
  ae: 'AE', uae: 'AE', 'u.a.e.': 'AE', 'united arab emirates': 'AE', emirates: 'AE', dubai: 'AE',
  sg: 'SG', singapore: 'SG',
  au: 'AU', australia: 'AU',
  nz: 'NZ', 'new zealand': 'NZ',
  in: 'IN', india: 'IN', bharat: 'IN',
};

/** Lowercase, collapse internal whitespace, trim. The grouping key for a raw destination. */
export function normalizeDestination(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The supported CountryCode a raw destination folds to, or null if unsupported. */
export function supportedCountryFor(raw: string): CountryCode | null {
  return SUPPORTED_ALIASES[normalizeDestination(raw)] ?? null;
}

function emptyStats(): CorridorWindowStats {
  return { leads: 0, distinctSenders: 0, usdDemand: 0, pricedLeads: 0 };
}

interface Accum {
  key: string;
  // raw spelling → count, to pick the most common display label deterministically
  labels: Map<string, number>;
  supported: boolean;
  // per-row data needed for windowing
  rows: { ts: number; sender: string; usd: number | null }[];
}

/**
 * Aggregate + rank corridor-demand leads by destination.
 *
 * @param requests   raw leads (from listCorridorRequests) — order-independent.
 * @param supported  the union of partners.countries we already deliver to.
 * @param fxRates    injected getFxRates — called ONCE per distinct source
 *                   currency that actually appears with an amount (most leads
 *                   are amount-less, so this is often called 0 times).
 * @param opts       windows + now anchor (tests pass fixed values).
 */
export async function rankCorridorDemand(
  requests: CorridorRequest[],
  supported: readonly CountryCode[],
  fxRates: FxRatesFn,
  opts: RankCorridorDemandOptions = {},
): Promise<CorridorDemand[]> {
  const now = opts.now ?? Date.now();
  const windows = [...(opts.windows ?? [7, 30, 90])].sort((a, b) => a - b);
  const supportedSet = new Set<CountryCode>(supported);

  // 1) Resolve the USD rate for every KNOWN currency that appears WITH an
  //    amount. One fetch per distinct currency; amount-less rows and off-enum
  //    currency strings never trigger one.
  const neededCurrencies = new Set<CurrencyCode>();
  for (const r of requests) {
    if (r.approxAmount == null) continue;
    const cur = normalizeCurrency(r.approxCurrency);
    if (cur) neededCurrencies.add(cur);
  }
  const usdRateByCurrency = new Map<CurrencyCode, number>();
  for (const cur of neededCurrencies) {
    try {
      const rates = await fxRates(cur);
      const toUsd = rates?.toUsd;
      if (typeof toUsd === 'number' && Number.isFinite(toUsd) && toUsd > 0) {
        usdRateByCurrency.set(cur, toUsd);
      }
    } catch {
      // FX outage for this currency: the amount is simply unpriced — leads and
      // distinct-sender counts (the primary signal) are unaffected.
    }
  }

  // 2) Bucket leads by normalized destination.
  const byKey = new Map<string, Accum>();
  for (const r of requests) {
    const supportedCountry = supportedCountryFor(r.destinationCountry);
    const key = supportedCountry ? supportedCountry.toLowerCase() : normalizeDestination(r.destinationCountry);
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        key,
        labels: new Map(),
        supported: supportedCountry != null && supportedSet.has(supportedCountry),
        rows: [],
      };
      byKey.set(key, acc);
    }
    const rawLabel = r.destinationCountry.trim();
    acc.labels.set(rawLabel, (acc.labels.get(rawLabel) ?? 0) + 1);

    let usd: number | null = null;
    if (r.approxAmount != null && r.approxCurrency) {
      const rate = usdRateByCurrency.get(r.approxCurrency);
      if (rate != null) usd = r.approxAmount * rate;
    }
    acc.rows.push({ ts: Date.parse(r.capturedAt), sender: r.senderPhone, usd });
  }

  // 3) Roll each bucket up into windowed stats + a growth slope.
  const shortest = windows[0];
  const result: CorridorDemand[] = [];
  for (const acc of byKey.values()) {
    const total = statsFor(acc.rows, () => true);
    const windowStats: Record<number, CorridorWindowStats> = {};
    for (const days of windows) {
      const cutoff = now - days * 86_400_000;
      windowStats[days] = statsFor(acc.rows, (ts) => Number.isFinite(ts) && ts >= cutoff);
    }

    // Growth: shortest window vs the equal-length window immediately before it.
    let growthLeads: number | null = null;
    let growthPct: number | null = null;
    if (shortest != null) {
      const span = shortest * 86_400_000;
      const recentCut = now - span;
      const priorCut = now - 2 * span; // start of the prior equal-length window
      const oldest = acc.rows.reduce((m, r) => (Number.isFinite(r.ts) ? Math.min(m, r.ts) : m), Infinity);
      // Only report growth once there's history reaching back into (or before)
      // the prior window — a destination whose every lead landed inside the
      // recent window is a cold start and would misleadingly read "+N this week".
      if (Number.isFinite(oldest) && oldest < recentCut) {
        const recent = acc.rows.filter((r) => Number.isFinite(r.ts) && r.ts >= recentCut).length;
        const prior = acc.rows.filter((r) => Number.isFinite(r.ts) && r.ts >= priorCut && r.ts < recentCut).length;
        growthLeads = recent - prior;
        growthPct = prior > 0 ? (growthLeads / prior) * 100 : null;
      }
    }

    result.push({
      key: acc.key,
      destination: pickLabel(acc.labels),
      supported: acc.supported,
      total,
      windows: windowStats,
      growthLeads,
      growthPct,
    });
  }

  // 4) Rank: leads desc → distinct senders desc → USD demand desc → key asc.
  result.sort((a, b) => {
    if (b.total.leads !== a.total.leads) return b.total.leads - a.total.leads;
    if (b.total.distinctSenders !== a.total.distinctSenders) {
      return b.total.distinctSenders - a.total.distinctSenders;
    }
    if (b.total.usdDemand !== a.total.usdDemand) return b.total.usdDemand - a.total.usdDemand;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return result;
}

function statsFor(
  rows: { ts: number; sender: string; usd: number | null }[],
  include: (ts: number) => boolean,
): CorridorWindowStats {
  const senders = new Set<string>();
  let leads = 0;
  let usdDemand = 0;
  let pricedLeads = 0;
  for (const r of rows) {
    if (!include(r.ts)) continue;
    leads++;
    senders.add(r.sender);
    if (r.usd != null) {
      usdDemand += r.usd;
      pricedLeads++;
    }
  }
  return {
    leads,
    distinctSenders: senders.size,
    usdDemand: Math.round(usdDemand * 100) / 100,
    pricedLeads,
  };
}

/** Most-frequent raw spelling, tiebroken alphabetically for determinism. */
function pickLabel(labels: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount || (count === bestCount && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}
