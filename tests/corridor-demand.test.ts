import { describe, it, expect, vi } from 'vitest';
import {
  rankCorridorDemand,
  normalizeDestination,
  supportedCountryFor,
  type FxRatesFn,
} from '@/lib/corridor-demand';
import type { CorridorRequest, CountryCode } from '@/lib/types';
import type { FxRates } from '@/lib/rate';

// corridor-demand — PURE aggregator. The FX function is injected, so these
// tests never hit the network. All time-relative fixtures are built off a
// fixed `NOW` anchor passed via opts (never hardcode a wall-clock date that
// interacts with the rolling windows — the project gotcha).

const NOW = Date.UTC(2026, 5, 17, 12, 0, 0); // anchor; tests pass it via opts.now
const DAY = 86_400_000;

function daysAgo(d: number): string {
  return new Date(NOW - d * DAY).toISOString();
}

let seq = 0;
function lead(over: Partial<CorridorRequest> & { destinationCountry: string }): CorridorRequest {
  seq += 1;
  return {
    id: `cr_${seq}`,
    senderPhone: `1555000${String(seq).padStart(4, '0')}`,
    capturedAt: daysAgo(1),
    ...over,
  };
}

// Default FX stub: identity USD, GBP≈1.27, AED≈0.27, INR≈0.012.
const RATES: Record<string, FxRates> = {
  USD: { toInr: 85, toUsd: 1 },
  GBP: { toInr: 108, toUsd: 1.27 },
  AED: { toInr: 23.1, toUsd: 0.27 },
  INR: { toInr: 1, toUsd: 0.012 },
};
const fxOk: FxRatesFn = vi.fn(async (cur) => RATES[cur] ?? { toInr: 1, toUsd: 1 });

const SUPPORTED: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

describe('normalizeDestination + supportedCountryFor', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeDestination('  Pak  istan ')).toBe('pak istan');
    expect(normalizeDestination('UAE')).toBe('uae');
  });

  it('folds known aliases of supported countries to their ISO code', () => {
    expect(supportedCountryFor('UAE')).toBe('AE');
    expect(supportedCountryFor('u.k.')).toBe('GB');
    expect(supportedCountryFor('United States')).toBe('US');
    expect(supportedCountryFor('india')).toBe('IN');
  });

  it('returns null for anything unrecognised', () => {
    expect(supportedCountryFor('Pakistan')).toBeNull();
    expect(supportedCountryFor('Brazil')).toBeNull();
    expect(supportedCountryFor('')).toBeNull();
  });
});

describe('rankCorridorDemand — empty + degenerate inputs', () => {
  it('returns [] for no requests', async () => {
    expect(await rankCorridorDemand([], SUPPORTED, fxOk, { now: NOW })).toEqual([]);
  });

  it('never invokes FX when no lead carries an amount', async () => {
    const fx = vi.fn(fxOk);
    const out = await rankCorridorDemand(
      [lead({ destinationCountry: 'Pakistan' }), lead({ destinationCountry: 'Brazil' })],
      SUPPORTED,
      fx,
      { now: NOW },
    );
    expect(fx).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.total.usdDemand === 0 && d.total.pricedLeads === 0)).toBe(true);
  });
});

describe('rankCorridorDemand — grouping + distinct senders (counts only, never phones)', () => {
  it('groups by normalized destination and counts distinct senders', async () => {
    const reqs = [
      lead({ destinationCountry: 'Pakistan', senderPhone: '111' }),
      lead({ destinationCountry: 'pakistan', senderPhone: '111' }), // same sender, diff spelling
      lead({ destinationCountry: 'PAKISTAN', senderPhone: '222' }),
      lead({ destinationCountry: 'Brazil', senderPhone: '333' }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW });
    const pk = out.find((d) => d.key === 'pakistan')!;
    expect(pk.total.leads).toBe(3);
    expect(pk.total.distinctSenders).toBe(2); // 111 (twice) + 222
    // No phone number leaks into the output anywhere.
    expect(JSON.stringify(out)).not.toContain('111');
    expect(JSON.stringify(out)).not.toContain('222');
  });

  it('picks the most common raw spelling as the display label', async () => {
    const reqs = [
      lead({ destinationCountry: 'Pakistan' }),
      lead({ destinationCountry: 'Pakistan' }),
      lead({ destinationCountry: 'pakistan' }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW });
    expect(out[0].destination).toBe('Pakistan');
  });
});

describe('rankCorridorDemand — USD normalization across mixed currencies', () => {
  it('sums USD demand only for priced rows, converting each currency once', async () => {
    const fx = vi.fn(fxOk);
    const reqs = [
      lead({ destinationCountry: 'Pakistan', approxAmount: 100, approxCurrency: 'USD' }),
      lead({ destinationCountry: 'Pakistan', approxAmount: 100, approxCurrency: 'GBP' }), // 127 USD
      lead({ destinationCountry: 'Pakistan' }), // unpriced (no amount)
      lead({ destinationCountry: 'Pakistan', approxAmount: 50 }), // amount but NO currency → unpriced
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fx, { now: NOW });
    const pk = out[0];
    expect(pk.total.leads).toBe(4);
    expect(pk.total.pricedLeads).toBe(2);
    expect(pk.total.usdDemand).toBeCloseTo(227, 5); // 100*1 + 100*1.27
    // GBP + USD distinct currencies → exactly 2 fx calls (deduped).
    expect(fx).toHaveBeenCalledTimes(2);
  });

  it('an FX outage for one currency leaves that row unpriced but counts the lead', async () => {
    const fx: FxRatesFn = vi.fn(async (cur) => {
      if (cur === 'AED') throw new Error('fx down');
      return RATES[cur] ?? { toInr: 1, toUsd: 1 };
    });
    const reqs = [
      lead({ destinationCountry: 'Nepal', approxAmount: 100, approxCurrency: 'USD' }),
      lead({ destinationCountry: 'Nepal', approxAmount: 100, approxCurrency: 'AED' }), // fx throws
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fx, { now: NOW });
    expect(out[0].total.leads).toBe(2);
    expect(out[0].total.pricedLeads).toBe(1);
    expect(out[0].total.usdDemand).toBeCloseTo(100, 5);
  });
});

describe('rankCorridorDemand — supported gap flag', () => {
  it('flags a destination that folds to a supported country as supported', async () => {
    const out = await rankCorridorDemand(
      [lead({ destinationCountry: 'UAE' }), lead({ destinationCountry: 'Pakistan' })],
      SUPPORTED,
      fxOk,
      { now: NOW },
    );
    expect(out.find((d) => d.key === 'ae')!.supported).toBe(true);
    expect(out.find((d) => d.key === 'pakistan')!.supported).toBe(false);
  });

  it('a supported-by-alias country is NOT flagged supported when the partner set excludes it', async () => {
    const out = await rankCorridorDemand(
      [lead({ destinationCountry: 'UAE' })],
      ['US', 'IN'], // partner does not serve AE
      fxOk,
      { now: NOW },
    );
    expect(out[0].supported).toBe(false);
  });
});

describe('rankCorridorDemand — rolling windows + boundaries', () => {
  it('window counts include the cutoff edge and exclude older leads', async () => {
    const reqs = [
      lead({ destinationCountry: 'Peru', capturedAt: daysAgo(1) }),
      lead({ destinationCountry: 'Peru', capturedAt: daysAgo(6) }),
      lead({ destinationCountry: 'Peru', capturedAt: daysAgo(7) }), // exactly 7d → inside 7d window (>= cutoff)
      lead({ destinationCountry: 'Peru', capturedAt: daysAgo(20) }),
      lead({ destinationCountry: 'Peru', capturedAt: daysAgo(100) }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW, windows: [7, 30, 90] });
    const peru = out[0];
    expect(peru.total.leads).toBe(5);
    expect(peru.windows[7].leads).toBe(3); // 1d, 6d, 7d
    expect(peru.windows[30].leads).toBe(4); // + 20d
    expect(peru.windows[90].leads).toBe(4); // 100d excluded
  });
});

describe('rankCorridorDemand — growth slope', () => {
  it('reports positive growth when the recent window outpaces the prior equal window', async () => {
    const reqs = [
      // recent 7d: 3 leads
      lead({ destinationCountry: 'Ghana', capturedAt: daysAgo(1) }),
      lead({ destinationCountry: 'Ghana', capturedAt: daysAgo(3) }),
      lead({ destinationCountry: 'Ghana', capturedAt: daysAgo(5) }),
      // prior 7d (8–14d ago): 1 lead — and gives us a full prior window of history
      lead({ destinationCountry: 'Ghana', capturedAt: daysAgo(10) }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW, windows: [7, 30] });
    const ghana = out[0];
    expect(ghana.growthLeads).toBe(2); // 3 recent − 1 prior
    expect(ghana.growthPct).toBeCloseTo(200, 5); // +200% off a base of 1
  });

  it('growth is null on a cold start (no full prior window of history)', async () => {
    const reqs = [
      lead({ destinationCountry: 'Kenya', capturedAt: daysAgo(1) }),
      lead({ destinationCountry: 'Kenya', capturedAt: daysAgo(2) }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW, windows: [7, 30] });
    expect(out[0].growthLeads).toBeNull();
    expect(out[0].growthPct).toBeNull();
  });

  it('growthPct is null when the prior window is empty but history is old enough', async () => {
    const reqs = [
      lead({ destinationCountry: 'Mali', capturedAt: daysAgo(1) }), // recent
      lead({ destinationCountry: 'Mali', capturedAt: daysAgo(20) }), // old history, but outside prior 7d window
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW, windows: [7] });
    expect(out[0].growthLeads).toBe(1); // 1 recent − 0 prior
    expect(out[0].growthPct).toBeNull(); // prior window empty
  });
});

describe('rankCorridorDemand — ranking + ties', () => {
  it('ranks by leads, then distinct senders, then USD demand, then key asc', async () => {
    const reqs = [
      // A: 2 leads, 2 senders, 0 usd
      lead({ destinationCountry: 'Alpha', senderPhone: 'a1' }),
      lead({ destinationCountry: 'Alpha', senderPhone: 'a2' }),
      // B: 2 leads, 1 sender, big usd
      lead({ destinationCountry: 'Bravo', senderPhone: 'b1', approxAmount: 1000, approxCurrency: 'USD' }),
      lead({ destinationCountry: 'Bravo', senderPhone: 'b1' }),
      // C: 3 leads, 1 sender
      lead({ destinationCountry: 'Charlie', senderPhone: 'c1' }),
      lead({ destinationCountry: 'Charlie', senderPhone: 'c1' }),
      lead({ destinationCountry: 'Charlie', senderPhone: 'c1' }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW });
    expect(out.map((d) => d.key)).toEqual(['charlie', 'alpha', 'bravo']);
    // Charlie wins on lead count; Alpha beats Bravo on distinct senders (2 > 1).
  });

  it('breaks an exact tie alphabetically by key for stable ordering', async () => {
    const reqs = [
      lead({ destinationCountry: 'Zed', senderPhone: 'z' }),
      lead({ destinationCountry: 'Apex', senderPhone: 'a' }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW });
    expect(out.map((d) => d.key)).toEqual(['apex', 'zed']);
  });
});

describe('rankCorridorDemand — malformed timestamps degrade gracefully', () => {
  it('counts a lead with an unparseable date in totals but not in any window', async () => {
    const reqs = [
      lead({ destinationCountry: 'Togo', capturedAt: 'not-a-date' }),
      lead({ destinationCountry: 'Togo', capturedAt: daysAgo(1) }),
    ];
    const out = await rankCorridorDemand(reqs, SUPPORTED, fxOk, { now: NOW, windows: [7] });
    expect(out[0].total.leads).toBe(2);
    expect(out[0].windows[7].leads).toBe(1); // only the parseable, in-window one
  });
});
