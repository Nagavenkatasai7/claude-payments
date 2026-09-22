// The landing page's corridor list — ONE source of truth shared by the
// "Partner with us" checkboxes, its server action's allow-list, and the
// waitlist's destination-country multi-select. Lives outside page.tsx because
// Next.js forbids extra exports from a page module.
//
// Values are the codes the server actions accept (10 supported corridors +
// an "Other" escape hatch); labels are the friendly names shown to prospects.
export const PARTNER_CORRIDORS = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'AE', label: 'UAE' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AU', label: 'Australia' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'IN', label: 'India' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'MX', label: 'Mexico' },
  { value: 'Other', label: 'Other' },
] as const;

export type PartnerCorridorCode = (typeof PARTNER_CORRIDORS)[number]['value'];

/** Server-side allow-list for the partner form: anything outside it is dropped. */
export const PARTNER_CORRIDOR_CODES: ReadonlySet<string> = new Set(PARTNER_CORRIDORS.map((c) => c.value));

/** Waitlist destination countries: the same list minus "Other" (not a country — counts are per country). */
export const WAITLIST_DESTINATIONS = PARTNER_CORRIDORS.filter((c) => c.value !== 'Other');

export const WAITLIST_DESTINATION_CODES: ReadonlySet<string> = new Set(WAITLIST_DESTINATIONS.map((c) => c.value));
