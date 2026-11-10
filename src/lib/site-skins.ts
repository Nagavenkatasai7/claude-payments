// site-skins — a partner-branded LOOK on a <slug>.smartremit.ai host that an EXISTING tenant serves
// (owner go 2026-11-09, "create the URL first": tgfl.smartremit.ai for the TGFL demo).
//
// PURE and dependency-free (like site-host.ts): the resolver, the portal loader, the slug writer and
// the portal layout all import it.
//
// A skin is NOT a partner. It changes only what the portal chrome shows (the name or logo in the
// header, optional colours, the tab title, a demo line, "Powered by SmartRemit"). The tenant, the
// accounts, the sign-in code, the bot, the pay page, receipts and every money path stay those of
// `partnerId`, and PortalSite.brand stays SmartRemit (owner decision 2026-10-04), because those
// messages come from SmartRemit's own number and mail and must keep naming the real sender.
//
// The list is CODE, not data: adding or changing a skin is a reviewed PR, and tests/site-skins.test.ts
// checks every entry. Rules the rest of the code keeps:
// - the host answers only while the "TGFL demo portal" switch (flag `portal.skins`) is on;
// - a real partner that holds, or ever held, the slug always wins (site-tenant-resolver.ts);
// - no partner can claim a skin slug (setPartnerSlug).
// A skin slug is deliberately NOT in RESERVED_SLUGS: a reserved label makes the host "refused"
// (404 in the proxy) and would never reach the resolver.
import { DEFAULT_PARTNER_ID } from './defaults';

export interface SiteSkin {
  /** The host label: `<slug>.smartremit.ai`. Equal to its key in SITE_SKINS. */
  slug: string;
  /** The EXISTING tenant that serves this host. */
  partnerId: string;
  /** Shown in the header (as text, or as the logo's alt text), the tab title and the demo line. */
  name: string;
  /** A file under /public/brand/partners/ (see skinLogoSrc), or null for a text wordmark. */
  logoSrc: string | null;
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
  // tgfl.org, not tgfl.com). A community association, not a licensed partner; nothing signed. No
  // logo file or brand colours in the repo yet, so the header shows the name as text in
  // SmartRemit's colours. Custom address: smartremitai.tgfl.org (a CNAME on TGFL's DNS).
  tgfl: {
    slug: 'tgfl', partnerId: DEFAULT_PARTNER_ID, name: 'TGFL', logoSrc: null, theme: null, demo: true,
    hosts: ['smartremitai.tgfl.org'], credentialEpoch: 1,
  },
};

/** Every custom skin host → its skin slug (exact, lowercase keys). parseSiteHost and the proxy matcher use it. */
export const CUSTOM_SKIN_HOSTS: ReadonlyMap<string, string> = new Map(
  Object.values(SITE_SKINS).flatMap((s) => s.hosts.map((h) => [h, s.slug] as const)),
);

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
