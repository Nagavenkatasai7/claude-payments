// featured-send-partner (Home-Send H1) — which partner, if any, the home page
// features behind its "Send with <partner>" button.
//
// SERVER-ONLY (db + log): imported by the landing page (src/app/page.tsx), never
// by the client calculator, which gets only the resolved FeaturedSendPartner.
//
// Configured by env (v1): FEATURED_SEND_PARTNER_ID names the partner, and
// FEATURED_SEND_MODE is 'test' (default) or 'live'. LIVE is granted only when ALL
// hold: FEATURED_SEND_MODE is exactly 'live', FEATURED_SEND_LIVE_CONFIRMED is exactly
// 'true' (owner sets it only after a licensed partner + real-money switches, home-send
// SPEC §3), and the partner has a configured licensed entity. Anything else renders
// the test copy, so the page never calls a test partner "a licensed money transmitter".
// SmartRemit's own (default) tenant may be featured, but only ever in test mode.
// The partner is VALID only if it exists, is active, and
// has a partner_sites slug that is a servable host label. Anything else — and any
// error — resolves to null: FAIL-CLOSED to "no button".
//
// Tenant safety: one partner, by the configured id, through the tenant-scoped
// readers (partner-repo getPartner, partner-site-repo getPartnerSite). Read-only.
import { env } from '@/lib/env';
import { getDb, type DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { getPartnerSite, type PartnerSite } from '@/db/repos/partner-site-repo';
import { resolvePartnerBranding, resolvePartnerDisclosure } from '@/lib/partner-config';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { logWarn } from '@/lib/log';
import { isHandoffSlug, type FeaturedSendPartner } from '@/lib/send-handoff';

export type { FeaturedSendPartner } from '@/lib/send-handoff';

type EnvLike = Record<string, string | undefined>;

export interface FeaturedSendConfig {
  partnerId: string;
  mode: 'test' | 'live';
}

/** Pure: the configured partner id + mode, or null when no partner is configured. */
export function readFeaturedSendConfig(e: EnvLike): FeaturedSendConfig | null {
  const partnerId = (e.FEATURED_SEND_PARTNER_ID ?? '').trim();
  if (!partnerId) return null;
  const live = e.FEATURED_SEND_MODE === 'live' && e.FEATURED_SEND_LIVE_CONFIRMED === 'true';
  return { partnerId, mode: live ? 'live' : 'test' };
}

function processEnv(): EnvLike {
  return {
    FEATURED_SEND_PARTNER_ID: env.featuredSendPartnerId,
    FEATURED_SEND_MODE: env.featuredSendMode,
    FEATURED_SEND_LIVE_CONFIRMED: env.featuredSendLiveConfirmed,
  };
}

/** The featured partner for the home-page button, or null (no button). Never throws. */
export async function resolveFeaturedSendPartner(
  deps: {
    env?: EnvLike;
    db?: DbOrTx;
    getSite?: (db: DbOrTx, partnerId: string) => Promise<PartnerSite | null>;
  } = {},
): Promise<FeaturedSendPartner | null> {
  // Unset ⇒ return before any db work: zero cost while nothing is featured.
  const config = readFeaturedSendConfig(deps.env ?? processEnv());
  if (!config) return null;
  // SmartRemit's own tenant may be featured for testing, but it is never a licensed transmitter:
  // it is always TEST mode and never carries a legal name (owner 2026-09-29).
  const isDefault = config.partnerId === DEFAULT_PARTNER_ID;
  try {
    const db = deps.db ?? getDb();
    const partner = await createPartnerRepo(db).getPartner(config.partnerId);
    if (!partner || partner.status !== 'active') return null;
    const site = await (deps.getSite ?? getPartnerSite)(db, config.partnerId);
    const slug = site?.slug;
    if (!isHandoffSlug(slug)) return null;
    const disclosure = resolvePartnerDisclosure(partner);
    const legalName = !isDefault && disclosure.configured ? disclosure.licensedEntity : null;
    return {
      displayName: resolvePartnerBranding(partner).brand,
      ...(legalName ? { legalName } : {}),
      slug,
      // No configured licensed entity ⇒ never live: the live disclosure must name it.
      mode: config.mode === 'live' && legalName ? 'live' : 'test',
    };
  } catch (err) {
    logWarn('featured-send-partner', err);
    return null;
  }
}

/**
 * Per-instance memo TTL: the FX soft TTL (src/lib/rate.ts CACHE_TTL_MS, 5 min). The
 * landing route renders per request (it awaits searchParams), so without this a
 * configured partner would cost two Neon reads on every home-page view.
 */
export const FEATURED_SEND_TTL_MS = 300_000;

let memo: { key: string; at: number; value: Promise<FeaturedSendPartner | null> } | null = null;

/** Tests only: drop the memo. */
export function resetFeaturedSendPartnerCache(): void {
  memo = null;
}

/**
 * What the landing page calls: resolveFeaturedSendPartner, memoised per instance for
 * FEATURED_SEND_TTL_MS and keyed on the config (partner + mode), so an env change
 * after a redeploy is never served stale. The resolver never throws, so a cached
 * value is always a partner or a fail-closed null. Unset env ⇒ null, nothing cached.
 */
export function getFeaturedSendPartner(
  deps: {
    env?: EnvLike;
    now?: () => number;
    resolve?: (deps: { env: EnvLike }) => Promise<FeaturedSendPartner | null>;
  } = {},
): Promise<FeaturedSendPartner | null> {
  const e = deps.env ?? processEnv();
  const config = readFeaturedSendConfig(e);
  if (!config) return Promise.resolve(null);
  const key = `${config.partnerId}\u0000${config.mode}`;
  const now = (deps.now ?? Date.now)();
  if (memo && memo.key === key && now - memo.at < FEATURED_SEND_TTL_MS) return memo.value;
  const value = (deps.resolve ?? resolveFeaturedSendPartner)({ env: e });
  memo = { key, at: now, value };
  return value;
}
