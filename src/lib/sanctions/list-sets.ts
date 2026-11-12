// list-sets — Fix pack 5 (R08, P24): the sanctions sources SmartRemit knows,
// and the code floor of lists every screen needs under SANCTIONS_LIST=lists.
// Pure: no I/O, no env, no clock.
//
// The floor is the code minimum counsel confirms per corridor (the owner step
// in the pack 5 index). It is keyed by DESTINATION country, deliberately not
// by a partner's corridorCompliance (which is keyed by source country): the
// lists a payout needs follow where the money lands. OFAC SDN and OFAC
// consolidated apply everywhere; India adds the UN Security Council list and
// the India MHA UAPA list. Nothing reads this until the multi-list screener
// (T28); the production default (SANCTIONS_LIST unset / 'mock' / 'ofac-sdn')
// is unchanged.

import type { CountryCode } from '../types';

export const SANCTIONS_SOURCES = Object.freeze(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa'] as const);
export type SanctionsSourceId = (typeof SANCTIONS_SOURCES)[number];

export const SANCTIONS_FLOOR = Object.freeze({
  every: Object.freeze(['ofac-sdn', 'ofac-cons'] as const),
  byDestination: Object.freeze({
    IN: Object.freeze(['un-sc', 'in-mha-uapa'] as const),
  }) as Readonly<Partial<Record<CountryCode, readonly SanctionsSourceId[]>>>,
});

export function isSanctionsSourceId(v: string): v is SanctionsSourceId {
  return (SANCTIONS_SOURCES as readonly string[]).includes(v);
}

/**
 * The lists a screen for this destination must use: `every` plus the
 * destination's own, in SANCTIONS_SOURCES order, no duplicates, frozen. No
 * destination (unknown at screen time) -> all four, the strictest union.
 */
export function floorLists(destinationCountry?: CountryCode | null): readonly SanctionsSourceId[] {
  if (destinationCountry == null) return SANCTIONS_SOURCES;
  const wanted = new Set<SanctionsSourceId>([
    ...SANCTIONS_FLOOR.every,
    ...(SANCTIONS_FLOOR.byDestination[destinationCountry] ?? []),
  ]);
  return Object.freeze(SANCTIONS_SOURCES.filter((s) => wanted.has(s)));
}
