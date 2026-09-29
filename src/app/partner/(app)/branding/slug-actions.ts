'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { getPartnerSite, setPartnerSlug } from '@/db/repos/partner-site-repo';
import { partnerMayClaimSlug } from '@/lib/partner-slug-policy';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { getRedis } from '@/lib/redis';
import { scopeOf } from '@/lib/staff-scope';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/branding: the partner's ONE-TIME web-address (slug) claim (UI redesign M3-18).
//  - refuseOnSiteHost() first, then the gate (PARTNER_ADMIN, MFA enforced) outside any try;
//  - the tenant is ALWAYS the session's (ctx.partnerId); no form field names a partner;
//  - a per-partner throttle (10 attempts an hour) BEFORE any slug read, so an admin cannot walk the
//    namespace to learn which slugs are taken; a throttle-store outage refuses (fail closed);
//  - reserved, taken, tombstoned and malformed slugs share ONE response (no oracle);
//  - claim-once is re-checked by setPartnerSlug inside its transaction (the pre-check here only picks
//    the message); a change after the claim is SmartRemit's (changePartnerSlugAction).
// The input is lowercased and trimmed, matching the proxy's host allowlist (it lowercases the host,
// src/lib/site-host.ts hostnameOf) and the send-handoff pin (https://<slug>.smartremit.ai).

const CLAIM_LIMIT_PER_HOUR = 10;
/** Longer than any valid slug (30) with room for spaces; anything longer is refused unread. */
const MAX_SLUG_INPUT = 64;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const unavailable = (): ActionResult => ({ ok: false, error: t('partner.slug.unavailable') });
const failed = (): ActionResult => ({ ok: false, error: t('partner.branding.failed') });
const claimedAlready = (): ActionResult => ({ ok: false, error: t('partner.slug.contactSmartRemit') });

export async function claimSlugAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);

  try {
    const rl = await checkIpRateLimit(getRedis(), 'partner.slug.claim', ctx.partnerId, {
      limit: CLAIM_LIMIT_PER_HOUR,
      windowSec: 3600,
    });
    if (!rl.allowed) return { ok: false, error: t('partner.slug.throttled') };
  } catch (err) {
    logWarn('partner.slug.claim', `throttle ${errName(err)}`, { partnerId: ctx.partnerId });
    return failed();
  }

  const raw = formData.get('slug');
  if (typeof raw !== 'string' || raw.length > MAX_SLUG_INPUT) return unavailable();
  const slug = raw.trim().toLowerCase();

  let r: Awaited<ReturnType<typeof setPartnerSlug>>;
  try {
    const db = getDb();
    if (!partnerMayClaimSlug(await getPartnerSite(db, ctx.partnerId))) return claimedAlready();
    r = await setPartnerSlug(db, ctx.partnerId, slug, ctx.username, { mode: 'claim', actorScope: scopeOf(ctx.staff).kind });
  } catch (err) {
    logWarn('partner.slug.claim', errName(err), { partnerId: ctx.partnerId });
    return failed();
  }
  if (!r.ok) {
    if (r.reason === 'already_claimed') return claimedAlready();
    if (r.reason === 'not_found') return { ok: false, error: t('partner.branding.notFound') };
    return unavailable();
  }
  revalidatePath(PARTNER_ROUTES.branding.href);
  return { ok: true };
}
