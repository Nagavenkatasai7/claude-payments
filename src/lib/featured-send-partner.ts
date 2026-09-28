// featured-send-partner (Home-Send H1) — which partner, if any, the home page
// features behind its "Send with <partner>" button.
//
// SERVER-ONLY (db + log): imported by the landing page (src/app/page.tsx), never
// by the client calculator, which gets only the resolved FeaturedSendPartner.
//
// Configured by env (v1): FEATURED_SEND_PARTNER_ID names the partner, and
// FEATURED_SEND_MODE is 'test' (default; anything but the exact 'live') or 'live'.
// The partner is VALID only if it exists, is active, is not the demo tenant, and
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
  return { partnerId, mode: e.FEATURED_SEND_MODE === 'live' ? 'live' : 'test' };
}

function processEnv(): EnvLike {
  return { FEATURED_SEND_PARTNER_ID: env.featuredSendPartnerId, FEATURED_SEND_MODE: env.featuredSendMode };
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
  if (config.partnerId === DEFAULT_PARTNER_ID) return null; // the demo tenant is never a licensed transmitter
  try {
    const db = deps.db ?? getDb();
    const partner = await createPartnerRepo(db).getPartner(config.partnerId);
    if (!partner || partner.status !== 'active') return null;
    const site = await (deps.getSite ?? getPartnerSite)(db, config.partnerId);
    const slug = site?.slug;
    if (!isHandoffSlug(slug)) return null;
    const disclosure = resolvePartnerDisclosure(partner);
    const legalName = disclosure.configured ? disclosure.licensedEntity : null;
    return {
      displayName: resolvePartnerBranding(partner).brand,
      ...(legalName ? { legalName } : {}),
      slug,
      mode: config.mode,
    };
  } catch (err) {
    logWarn('featured-send-partner', err);
    return null;
  }
}
