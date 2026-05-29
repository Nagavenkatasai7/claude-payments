import type { CountryCode } from '../types';

export interface SanctionsHit {
  matched: boolean;
  matchedName?: string;
  listSource?: string;   // e.g. 'mock-watchlist' | future 'OFAC-SDN'
}

/**
 * The pluggable sanctions-screening seam (P5), mirroring KycProvider. A real
 * provider (ComplyAdvantage / Sanctions.io) implements the same interface and
 * is swapped in by changing getSanctionsScreener — no call-site change.
 * The contract returns a Promise so a network-backed provider needs no
 * signature change; the mock resolves immediately.
 */
export interface SanctionsScreener {
  screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit>;
}

/**
 * MockSanctionsScreener: P5 stand-in. Reproduces TODAY's compliance.ts logic —
 * case-insensitive, trimmed, exact-match against a base list (WATCHLIST plus
 * any corridor watchlistExtra). sourceCountry is accepted (so a real provider
 * can scope by jurisdiction) but unused here.
 */
export class MockSanctionsScreener implements SanctionsScreener {
  constructor(private readonly baseList: string[]) {}

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const name = (input.name ?? '').trim().toLowerCase();          // defensive ?? '' (untrusted)
    if (name === '') return { matched: false };
    const list = (this.baseList ?? []).map((n) => (n ?? '').trim().toLowerCase());
    return list.includes(name)
      ? { matched: true, matchedName: name, listSource: 'mock-watchlist' }
      : { matched: false };
  }
}

// Factory parallel to a future getKycProvider(); lets a real provider swap in.
export function getSanctionsScreener(baseList: string[]): SanctionsScreener {
  return new MockSanctionsScreener(baseList);
}
