// partner-slug-policy (UI redesign M3-18): a partner claims its site address ONCE, from
// /partner/branding. After that only SmartRemit changes it (the platform-only action on the
// partner's admin page), and a released slug is never reused (partner_slug_tombstones).
// This is the UI-side question only; setPartnerSlug re-checks it inside its transaction.

/** True only when the partner has no slug yet (no site row, or a row whose slug is null). */
export function partnerMayClaimSlug(site: { slug: string | null } | null): boolean {
  return site === null || site.slug === null;
}
