import { cookies, headers } from 'next/headers';
import { getAuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import { staffSessionTokens } from './session-cookie';
import { parseSiteHost } from './site-host';
import { decidePartnerAccess, type PartnerCtx, type PartnerPolicy } from './partner-access';
import { partnerMfaEnrolmentPending } from './partner-mfa-gate';

/**
 * partner-live-access (lost-features A15): the session check behind GET /partner/live. The same
 * decision as requirePartnerStaff (decidePartnerAccess, MFA enrolment enforced), with two
 * differences a polling endpoint needs:
 *   - the session is PEEKED (auth-store peekSessionUser): a poll never refreshes lastSeen, so live
 *     refresh never extends the 30-minute idle sign-out (review 2.13);
 *   - a refusal is `null`, never a redirect (a fetch would follow it): the route answers 401.
 * The checks getCurrentStaff makes (suspended member, suspended or missing partner) are repeated here
 * because auth.ts is frozen. Only the apex serves it (as refuseOnSiteHost for actions).
 */
export async function peekPartnerStaff(policy: PartnerPolicy): Promise<PartnerCtx | null> {
  if (parseSiteHost((await headers()).get('host')).kind !== 'apex') return null;
  let username: string | null = null;
  for (const { token } of staffSessionTokens(await cookies())) {
    username = await getAuthStore().peekSessionUser(token);
    if (username) break;
  }
  if (!username) return null;
  const staff = await getAuthStore().getStaff(username);
  if (!staff || staff.status === 'suspended') return null;
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') return null;
  }
  const pending = staff.partnerId ? await partnerMfaEnrolmentPending(staff) : false;
  const d = decidePartnerAccess(staff, policy, { pending });
  return d.ok ? d.ctx : null;
}
