'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth, requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalSessionStore } from '@/lib/portal-session-store';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { customerKey, getCustomerMfaStore, recordCustomerMfaAudit } from '@/lib/customer-mfa';
import { startCustomerVerification } from '@/lib/customer-verification';
import { getPartnerStore } from '@/lib/partner-store';
import { resolveKycMode } from '@/lib/partner-config';
import { kycView, recordPortalPiiReveal } from '@/lib/portal-profile';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import type { RevealResult } from '@/components/ds';
import type { MessageKey } from '@/lib/i18n';

/**
 * The customer portal's Profile actions (UI redesign M2-11, Tasks 11.1-11.2). Each is a PUBLIC POST
 * endpoint: requirePortalSite() FIRST (the scanner pins it), then the session (the 15-minute step-up
 * for TOTP enrolment, the sensitive change here). Every read and write is keyed by the HOST partner
 * and the SESSION phone; nothing is taken from the form except the TOTP code. Results are fixed copy
 * keys. No redirect() inside a try (it throws).
 */

export type ProfileActionState = { notice?: MessageKey; error?: MessageKey } | null;
export interface PortalMfaState {
  ok: boolean;
  secret?: string;
  uri?: string;
  notice?: MessageKey;
  error?: MessageKey;
}

/** Per customer: 5 identity-verification starts an hour (each may create a provider inquiry). */
const PORTAL_KYC_LIMIT = { scope: 'portal-kyc', limit: 5, windowSec: 3600 } as const;
const PROFILE_PATH = '/portal/profile';

/**
 * Reveal the customer's OWN legal name (MaskedValue's action). Nothing is bound from the client, so
 * there is nothing to re-scope: the row is the session's on the host's tenant. `pii.reveal` is
 * written BEFORE the value is returned; a missing name or any failure is one generic error.
 */
export async function revealPortalLegalNameAction(): Promise<RevealResult> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const name = ctx.customer.fullName?.trim();
  if (!name) return { error: 'unavailable' };
  try {
    await recordPortalPiiReveal(getDb(), ctx.site.partnerId, ctx.session.phone, 'full_name');
  } catch (err) {
    logWarn('portal.profile.reveal', err);
    return { error: 'unavailable' };
  }
  return { value: name };
}

/**
 * Start identity verification through the SAME core as /account/verify. A 'delegated' partner runs KYC
 * itself: the portal refuses before the core (sanctions screening is untouched either way). A
 * verified or in-review customer is not sent to a new inquiry.
 */
export async function startPortalVerificationAction(_prev: ProfileActionState, _formData: FormData): Promise<ProfileActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  let url: string;
  try {
    const partner = await getPartnerStore().getPartner(ctx.site.partnerId);
    if (resolveKycMode(partner).mode === 'delegated') return { notice: 'portal.kyc.delegated' };
    if (!kycView(ctx.customer).canStart) return { notice: 'portal.kyc.already' };
    const rl = await checkIpRateLimit(getRedis(), PORTAL_KYC_LIMIT.scope, auditSubjectId(ctx.site.partnerId, ctx.session.phone), {
      limit: PORTAL_KYC_LIMIT.limit,
      windowSec: PORTAL_KYC_LIMIT.windowSec,
    });
    if (!rl.allowed) return { error: 'portal.kyc.rate_limited' };
    const res = await startCustomerVerification(ctx.customer, { actor: PORTAL_AUTH_ACTOR });
    if (res.kind === 'gate_off') return { notice: 'portal.kyc.not_required' };
    url = res.url;
  } catch (err) {
    logWarn('portal.profile.kyc_start', err);
    return { error: 'portal.action.failed' };
  }
  redirect(url);
}

/**
 * TOTP step 1 (step-up): a fresh secret, returned ONCE in the action state and held sealed for 10
 * minutes. The authenticator label is the partner's brand (owner O7); existing enrolments keep theirs.
 */
export async function beginPortalMfaEnrolmentAction(_prev: PortalMfaState, _formData: FormData): Promise<PortalMfaState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth(PROFILE_PATH);
  try {
    const begun = await getCustomerMfaStore().beginEnrolment(customerKey(ctx.customer), { issuer: ctx.site.brand });
    if (!begun.ok) return { ok: false, error: 'portal.mfa.already' };
    return { ok: true, secret: begun.secretBase32, uri: begun.uri };
  } catch (err) {
    logWarn('portal.profile.mfa_begin', err instanceof Error ? err.name : 'error');
    return { ok: false, error: 'portal.mfa.unavailable' };
  }
}

const CONFIRM_ERROR: Record<string, MessageKey> = {
  invalid: 'portal.mfa.invalid',
  throttled: 'portal.mfa.throttled',
  enrolled: 'portal.mfa.already',
  expired: 'portal.mfa.expired',
};

/**
 * TOTP step 2 (step-up): one code turns it on. Like the legacy enrolment, every OTHER portal session of
 * this customer on this partner is signed out; this one is stamped as TOTP-fresh so the next sensitive
 * action within 15 minutes does not ask again. Audited `customer.mfa.enroll`.
 */
export async function confirmPortalMfaEnrolmentAction(_prev: PortalMfaState, formData: FormData): Promise<PortalMfaState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth(PROFILE_PATH);
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
  const key = customerKey(ctx.customer);
  let outcome: string;
  try {
    outcome = await getCustomerMfaStore().confirmEnrolment(key, code);
  } catch (err) {
    logWarn('portal.profile.mfa_confirm', err instanceof Error ? err.name : 'error');
    return { ok: false, error: 'portal.mfa.unavailable' };
  }
  if (outcome !== 'ok') return { ok: false, error: CONFIRM_ERROR[outcome] ?? 'portal.mfa.expired' };
  const sessions = getPortalSessionStore();
  // The revoke is the point (a borrowed session must not outlive the new factor): if it fails the
  // customer is told to sign the other devices out from Devices, never that it happened.
  let revoked = true;
  try {
    await sessions.revokeAll(ctx.site.partnerId, ctx.session.phone, ctx.session.sid);
  } catch (err) {
    revoked = false;
    logWarn('portal.profile.mfa_revoke', err instanceof Error ? err.name : 'error');
  }
  // M2-14 (#399 L2): the factor is shared with the legacy apex /account (same partner + phone key),
  // so that surface's sessions go too, when its account belongs to THIS partner.
  try {
    const legacy = getCustomerAuthStore();
    if ((await legacy.getCustomer(ctx.session.phone))?.partnerId === ctx.site.partnerId) {
      await legacy.deleteAllSessions(ctx.session.phone);
    }
  } catch (err) {
    revoked = false;
    logWarn('portal.profile.mfa_revoke_legacy', err instanceof Error ? err.name : 'error');
  }
  try {
    await sessions.markStepUp(ctx.token, ctx.site.partnerId, { totp: true });
  } catch (err) {
    logWarn('portal.profile.mfa_stepup', err instanceof Error ? err.name : 'error');
  }
  try {
    await recordCustomerMfaAudit('customer.mfa.enroll', key, { via: 'portal' }, PORTAL_AUTH_ACTOR);
  } catch (err) {
    logWarn('portal.profile.mfa_audit', err instanceof Error ? err.name : 'error');
  }
  revalidatePath(PROFILE_PATH);
  return { ok: true, notice: revoked ? 'portal.mfa.on' : 'portal.mfa.on_revoke_failed' };
}
