// send-handoff (Home-Send H1) — the home-page "Send with <partner>" link and the
// featured-partner shape the landing calculator renders.
//
// PURE and import-free on purpose: the landing calculator ('use client',
// src/app/landing/RateCalculator.tsx) imports this module, so it must never pull
// in log.ts, the db, or anything server-side. The server resolver lives in
// featured-send-partner.ts and is imported only by the (server) landing page.
//
// The link parameters are a PRE-FILL HINT only: the partner portal re-validates
// them on its server. Anything doubtful is dropped here, never coerced, and the
// URL carries nothing but the partner slug, the amount and an ISO2 destination —
// never PII or ids.

/** What the landing page passes to the calculator. No partner id: RSC props are public HTML. */
export interface FeaturedSendPartner {
  /** The brand customers see (partner display name, else brand name). */
  displayName: string;
  /** The licensed entity from the partner's disclosure config, when configured. */
  legalName?: string;
  /** The partner's partner_sites slug: the portal is https://<slug>.smartremit.ai. */
  slug: string;
  /** 'test' ⇒ test-send copy and a "no real money" badge; 'live' only when explicitly set. */
  mode: 'test' | 'live';
}

/** The destinations the landing calculator quotes today (USD → INR only). */
export const CALCULATOR_DESTINATIONS: ReadonlySet<string> = new Set(['IN']);

/** Pre-fill amount bounds (USD). The portal applies the real caps. */
export const HANDOFF_MIN_AMOUNT = 1;
export const HANDOFF_MAX_AMOUNT = 10_000;

// Mirrors BOTH partner_sites checks (src/db/schema.ts): the format and the
// DNS-reserved '??--' prefix, so a link is only ever built for a servable host.
const SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const SLUG_RESERVED = /^..--/;

export function isHandoffSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_FORMAT.test(slug) && !SLUG_RESERVED.test(slug);
}

/**
 * https://<slug>.smartremit.ai/send[?amount=<n.nn>][&to=<ISO2>], or null when the
 * slug is not a valid partner_sites slug (no link at all).
 */
export function buildSendHandoffUrl(input: { slug: string; amount?: number; to?: string }): string | null {
  if (!isHandoffSlug(input.slug)) return null;
  const url = new URL(`https://${input.slug}.smartremit.ai/send`);
  const { amount, to } = input;
  if (
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount >= HANDOFF_MIN_AMOUNT &&
    amount <= HANDOFF_MAX_AMOUNT
  ) {
    url.searchParams.set('amount', amount.toFixed(2));
  }
  if (typeof to === 'string' && CALCULATOR_DESTINATIONS.has(to)) url.searchParams.set('to', to);
  return url.toString();
}
