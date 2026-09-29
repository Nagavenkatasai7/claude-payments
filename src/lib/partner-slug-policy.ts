// partner-slug-policy (UI redesign M3-18): a partner claims its site address ONCE, from
// /partner/branding. After that only SmartRemit changes it (the platform-only action on the
// partner's admin page), and a released slug is never reused (partner_slug_tombstones).
// This is the UI-side question only; setPartnerSlug re-checks it inside its transaction.

/** True only when the partner has no slug yet (no site row, or a row whose slug is null). */
export function partnerMayClaimSlug(site: { slug: string | null } | null): boolean {
  return site === null || site.slug === null;
}

/** Longer than any valid slug (30) with room for spaces; anything longer is refused unread. */
export const MAX_SLUG_INPUT = 64;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A form value → the candidate slug (trimmed, lowercased), or null. Only printable ASCII is
 * accepted BEFORE lowercasing, so Unicode case folding (e.g. the Kelvin sign → "k") can never turn
 * a look-alike into a valid slug. The result is still validated by setPartnerSlug (isValidSiteSlug).
 */
export function normalizeSlugInput(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_SLUG_INPUT || !PRINTABLE_ASCII.test(raw)) return null;
  return raw.trim().toLowerCase();
}
