import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { recordReferral } from './referral-attribution';
import { REFERRAL_COOKIE } from './referral-code';
import { logWarn } from './log';
import { customHostBinding } from './site-skins';
import type { PartnerId } from './types';

/**
 * Batch B4, the portal seam: after a customer has fully authenticated (and, for a new customer,
 * consented), the referral code the sign-in page kept in its cookie (src/proxy.ts) links them to
 * the referral partner, under the HOST partner. The cookie is spent on the first authenticated
 * sign-in whatever the outcome (first touch wins; a code never follows a second sign-in on a shared
 * device). BEST EFFORT: no cookie means no query, and any error only logs.
 *
 * D14: on a custom skin host (`host` is the canonical PortalSite.host) the cookie is never read: the
 * domain's owner can plant `sr_ref` for its whole parent domain, so it is not our proxy's cookie.
 */
export async function recordPortalReferral(partnerId: PartnerId, phone: string, host: string): Promise<void> {
  if (customHostBinding(host) !== null) return;
  try {
    const jar = await cookies();
    const raw = jar.get(REFERRAL_COOKIE)?.value;
    if (raw === undefined) return;
    jar.delete(REFERRAL_COOKIE);
    await recordReferral(getDb(), { partnerId, phone, code: raw, channel: 'portal' });
  } catch (err) {
    logWarn('referral.portal', err instanceof Error ? err.name : 'error', { partnerId });
  }
}
