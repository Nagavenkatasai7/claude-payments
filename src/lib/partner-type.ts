// partner-type — the "I am a:" choice on the public "Partner with us" form.
// ONE source of truth: the schema CHECK (src/db/schema.ts), the server action's
// validation, the landing radio group, and the admin filter all import it.
// Machine values are stored; labels are presentation only.
export const PARTNER_TYPES = [
  { value: 'referral', label: 'Referral partner (CPA, community organization)' },
  { value: 'business', label: 'Business accepting payments' },
  { value: 'licensed_mt', label: 'Licensed money transmitter' },
] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number]['value'];

export const PARTNER_TYPE_VALUES: readonly PartnerType[] = PARTNER_TYPES.map((t) => t.value);

export function isPartnerType(value: unknown): value is PartnerType {
  return typeof value === 'string' && (PARTNER_TYPE_VALUES as readonly string[]).includes(value);
}

export function partnerTypeLabel(value: string | undefined): string {
  return PARTNER_TYPES.find((t) => t.value === value)?.label ?? '—';
}

/**
 * The admin list filter (`?type=`). An allowed value keeps that type; 'none'
 * keeps legacy rows with no answer; anything else (absent, '', junk) is the
 * unfiltered list — an unknown filter never hides rows silently.
 */
export function filterByPartnerType<T extends { partnerType?: PartnerType }>(
  rows: T[],
  type: string | undefined,
): T[] {
  if (type === 'none') return rows.filter((r) => !r.partnerType);
  if (isPartnerType(type)) return rows.filter((r) => r.partnerType === type);
  return rows;
}
