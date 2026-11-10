// site-skins — a partner-branded LOOK on a host that an EXISTING tenant serves (owner go 2026-11-09,
// "create the URL first": tgfl.smartremit.ai for the TGFL demo). A skin answers on
// `<slug>.smartremit.ai` and on its exact custom hosts (`hosts`, e.g. smartremitai.tgfl.org, a CNAME
// on TGFL's DNS); both serve the same skinned portal.
//
// PURE: no I/O, and its only import is DEFAULT_PARTNER_ID from ./defaults (type imports and constants
// only). site-host.ts (and through it src/proxy.ts) imports it on the hot path; among others, the
// resolver, the portal loader, the slug writer, the portal sign-in and sign-out code, the portal
// step-up, profile and devices actions, the referral reader, the agent auth server and the portal
// layout import it too. It never imports site-host.ts, so there is no cycle.
//
// A skin is NOT a partner. It changes only what the portal chrome shows (the logo plus the name in the
// header, optional colours, the tab title, a demo line, "Powered by SmartRemit"). The tenant, the
// accounts, the sign-in code, the bot, the pay page, receipts and every money path stay those of
// `partnerId`, and PortalSite.brand stays SmartRemit (owner decision 2026-10-04), because those
// messages come from SmartRemit's own number and mail and must keep naming the real sender.
//
// The list is CODE, not data: adding or changing a skin is a reviewed PR, and tests/site-skins.test.ts
// checks every entry. Rules the rest of the code keeps:
// - every host of the skin answers only while the "TGFL demo portal" switch (flag `portal.skins`) is on;
// - a real partner that holds, or ever held, the slug always wins on `<slug>.smartremit.ai`
//   (site-tenant-resolver.ts); a custom host resolves the skin ONLY (resolveSkinHost) and answers 404
//   when it does not resolve, never another tenant and never the apex app;
// - no partner can claim a skin slug (setPartnerSlug);
// - portal sessions and AI-app refresh tokens minted on a custom host are bound to it
//   (customHostBinding), so they never work on a smartremit.ai host; bumping credentialEpoch revokes
//   them all. It does NOT end AI-app access tokens (not epoch-bound, they live up to
//   AGENT_ACCESS_TTL_SEC, 1 h, while their grant row stays live): keep portal.skins off for at least
//   1 h after switching it off, even once the bump is merged, or revoke those grants. Orphaned
//   sessions stay listed on the Devices page (dead, not usable) until their idle timeout;
// - never remove a host from `hosts` while its CNAME may still point at Vercel: it would parse as apex
//   and serve the staff sign-in (CLAUDE.md "Site skins", docs/ROLLBACK.md).
// A skin slug is deliberately NOT in RESERVED_SLUGS: a reserved label makes the host "refused"
// (404 in the proxy) and would never reach the resolver.
import { DEFAULT_PARTNER_ID } from './defaults';

export interface SiteSkin {
  /** The label of the skin's smartremit.ai host, `<slug>.smartremit.ai`. Equal to its key in SITE_SKINS. */
  slug: string;
  /** The EXISTING tenant that serves this host. */
  partnerId: string;
  /** Shown in the header (as text, after the logo when there is one, and as the logo's alt text), the tab title and the demo line. */
  name: string;
  /** A file under /public/brand/partners/ (see skinLogoSrc), or null for a text wordmark. */
  logoSrc: string | null;
  /**
   * The logo file's natural size in pixels (null exactly when logoSrc is null). The header sizes the
   * <img> from it, so the layout does not shift and the logo is never stretched above this size;
   * tests/site-skins.test.ts checks it against the file.
   */
  logoSize: { width: number; height: number } | null;
  /** Both colours must pass validateThemeColor; null keeps SmartRemit's colours. */
  theme: { primary: string; accent: string } | null;
  /** true shows the demo line ("… demo, run by SmartRemit. No real money moves.") on every page. */
  demo: boolean;
  /**
   * Exact extra hostnames OUTSIDE smartremit.ai that serve this skin (lowercase, no port, no trailing dot).
   * Each needs its literal in src/proxy.ts matcher entry (3); tests/site-matcher-parity.test.ts rebuilds it.
   * NEVER remove a host while its DNS may still point at Vercel: a host not in this list parses as apex
   * (CLAUDE.md "Site skins").
   */
  hosts: readonly string[];
  /** Bump to revoke every portal session and AI-app refresh token minted on this skin's custom hosts. */
  credentialEpoch: number;
}

export const SITE_SKINS: Readonly<Record<string, SiteSkin>> = {
  // TGFL = Telangana Association of Florida, https://tgfl.org (owner, 2026-11-09: the domain is
  // tgfl.org, not tgfl.com). A community association, not a licensed partner; nothing signed.
  // Logo: public/brand/partners/tgfl.png (150 x 100 PNG, clear background), the association's
  // emblem from the header of tgfl.org (Internet Archive capture 2025-07-19). The owner confirms
  // TGFL agrees to the use of its mark. The header shows the emblem with the name as text next to
  // it; no brand colours, so SmartRemit's colours apply. Custom address: smartremitai.tgfl.org (a
  // CNAME on TGFL's DNS).
  tgfl: {
    slug: 'tgfl', partnerId: DEFAULT_PARTNER_ID, name: 'TGFL',
    logoSrc: '/brand/partners/tgfl.png', logoSize: { width: 150, height: 100 }, theme: null, demo: true,
    hosts: ['smartremitai.tgfl.org'], credentialEpoch: 1,
  },
};

/** Every custom skin host → its skin slug (exact, lowercase keys). parseSiteHost and the proxy matcher use it. */
export const CUSTOM_SKIN_HOSTS: ReadonlyMap<string, string> = new Map(
  Object.values(SITE_SKINS).flatMap((s) => s.hosts.map((h) => [h, s.slug] as const)),
);

/**
 * The credential binding of a CANONICAL host (PortalSite.host / the OAuth ctx.host): `${host}#${epoch}`
 * for a custom skin host, null for every other host. The match is exact (no case folding, no port, no
 * trailing dot): callers pass the canonical host from parseSiteHost, never the raw header. The binding
 * is hashed into portal session keys and AI-app refresh-token hashes, so a credential minted on a custom
 * host never works on a smartremit.ai host (and the reverse); every smartremit.ai host gets null and
 * keeps its hashes byte for byte. Bumping the skin's credentialEpoch revokes them all.
 */
export function customHostBinding(host: string): string | null {
  if (typeof host !== 'string') return null;
  const slug = CUSTOM_SKIN_HOSTS.get(host);
  const skin = slug === undefined ? null : skinForSlug(slug);
  return skin ? `${host}#${skin.credentialEpoch}` : null;
}

/** Own keys only: 'constructor', '__proto__' and friends are never a skin. */
export function isSkinSlug(slug: string): boolean {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(SITE_SKINS, slug);
}

export function skinForSlug(slug: string): SiteSkin | null {
  return isSkinSlug(slug) ? SITE_SKINS[slug]! : null;
}

/**
 * The skin of a RESOLVED host, or null. It applies only when the host resolved to the skin's own
 * tenant: when a real partner holds the slug, the host is that partner's portal and shows no skin.
 */
export function siteSkinFor(slug: string, partnerId: string): SiteSkin | null {
  const skin = skinForSlug(slug);
  return skin && skin.partnerId === partnerId ? skin : null;
}

/** One file directly under /brand/partners/: no folder, no query, no traversal; raster only (no SVG). */
const SKIN_LOGO = /^\/brand\/partners\/[a-z0-9-]+\.(?:png|webp|jpe?g)$/;

/**
 * The skin logo as an <img src>, or null (the header then shows the name as text). Only a
 * same-origin raster file under /brand/partners/ is accepted; a remote URL, a data URI or an SVG is
 * dropped, so a skin can never load an image from another origin (the CSP would block it anyway).
 */
export function skinLogoSrc(skin: Pick<SiteSkin, 'logoSrc'>): string | null {
  const src = skin.logoSrc;
  return typeof src === 'string' && SKIN_LOGO.test(src) ? src : null;
}
