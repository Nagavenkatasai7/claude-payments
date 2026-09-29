'use server';

import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalOtpStore, PORTAL_OTP_IP_LIMIT } from '@/lib/portal-otp-store';
import { field, ipAllowed, issueAndSendAfterResponse, portalAudit as audit, PORTAL_VERIFY_IP_LIMIT as VERIFY_IP_LIMIT } from '@/lib/portal-login-flow';
import { getPortalPendingStore, PORTAL_PENDING_MAX_ATTEMPTS, type PortalPending } from '@/lib/portal-pending-store';
import { alertPortalOtpFailure, portalOtpChannelReady } from '@/lib/portal-otp-sender';
import { afterPortalResponse, completePortalSignIn, portalCustomers } from '@/lib/portal-auth';
import { getCustomerMfaStore } from '@/lib/customer-mfa';
import { getPortalTotpBudget } from '@/lib/portal-totp-budget';
import { isValidPhone, normalizePhone } from '@/lib/phone';
import type { MessageKey } from '@/lib/i18n';
import type { PartnerId } from '@/lib/types';

/**
 * Customer-portal sign-in (UI redesign M2-5, Task 5.4; SPEC §2.1). Each export is a PUBLIC POST
 * endpoint that starts with requirePortalSite(): it 404s on the apex, with the flag off, for a
 * partner that is not enabled or not active. The partner is ALWAYS the host's; the phone is typed
 * once, normalized once, and from then on read ONLY from the server-side pending record.
 *
 * ENUMERATION SAFETY (review round 1, M1/M2; carry-forward from the OTP store review):
 * - requestCodeAction's request path touches nothing phone-dependent: site gate → per-IP limit →
 *   format check → the partner's channel readiness (partner-only) → one pending-record write. It
 *   answers the SAME state for known, unknown, cooldown, locked, throttled and geo-refused phones.
 *   The customer lookup, the OTP issue, the send, every audit row and every alert run inside ONE
 *   after() callback (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:8,10).
 * - verify answers wrong / no_code / expired with ONE copy, and the store charges them the same
 *   budget; a store throw maps to that same copy (never success).
 * - The code is never returned, logged or stored outside the OTP store's hash.
 *
 * ORDER after a correct code (nothing is written for an unknown phone before full authentication):
 * code → TOTP if enrolled → first-sign-in consent (owner O11) if the row has no WhatsApp opt-in →
 * ensureCustomer + setOptedIn + audits → phone verified + session (rotated) + cookie → redirect.
 */

export type PortalLoginStep = 'phone' | 'code' | 'mfa' | 'consent';

export interface PortalLoginState {
  step: PortalLoginStep;
  /** Opaque single-use token (hidden field). Never the phone. */
  pending?: string;
  /** The last 4 digits of the number the customer typed (their own input; the same for every branch). */
  last4?: string;
  notice?: MessageKey;
  error?: MessageKey;
}

/** Step 1: send a code. The SAME answer for every well-formed phone (see the module note). */
export async function requestCodeAction(_prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  const site = await requirePortalSite();
  const pid = site.partnerId;
  let ipOk: boolean;
  try {
    ipOk = await ipAllowed(PORTAL_OTP_IP_LIMIT);
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }
  const phone = normalizePhone(field(formData, 'phone'));
  if (!isValidPhone(phone)) return { step: 'phone', error: 'portal.login.phone_invalid' };

  const ready = await portalOtpChannelReady(pid); // partner-only: no oracle
  if (!ready.ready) {
    await afterPortalResponse('portal.otp', async () => {
      await audit(pid, phone, 'otp_send_failed', { why: ready.why });
      await alertPortalOtpFailure(pid, ready.why);
    });
    return { step: 'phone', error: 'portal.login.cant_send' };
  }

  let pending: string;
  try {
    pending = await getPortalPendingStore().create({ partnerId: pid, phone, purpose: 'login' });
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }
  await issueAndSendAfterResponse(pid, phone, 'login', ipOk, ready);
  return { step: 'code', pending, last4: phone.slice(-4), notice: 'portal.login.code_sent_if_possible' };
}

/** "Send a new code" on the code step: the same after() discipline, keyed by the pending token. */
export async function resendCodeAction(_prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  const site = await requirePortalSite();
  const pid = site.partnerId;
  const pendingToken = field(formData, 'pending');
  let ipOk: boolean;
  let rec: PortalPending | null;
  try {
    ipOk = await ipAllowed(PORTAL_OTP_IP_LIMIT);
    rec = await getPortalPendingStore().peek(pendingToken, pid, 'login');
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }
  if (!rec) return { step: 'phone', error: 'portal.login.expired' };
  const ready = await portalOtpChannelReady(pid);
  if (!ready.ready) return { step: 'phone', error: 'portal.login.cant_send' };
  // M2-14 (PR 394 L7): the new code gets its own 5 minutes on this token (capped; see the store).
  try {
    await getPortalPendingStore().extend(pendingToken, pid, 'login');
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }
  await issueAndSendAfterResponse(pid, rec.phone, 'login', ipOk, ready);
  return { step: 'code', pending: pendingToken, last4: rec.phone.slice(-4), notice: 'portal.login.code_sent_if_possible' };
}

/** After a proven code (and TOTP where enrolled): consent if needed, else the session. */
async function nextAfterProof(pid: PartnerId, phone: string, totp = false): Promise<PortalLoginState | 'signed_in'> {
  const customer = await portalCustomers().getCustomer(pid, phone);
  if (!customer?.optInAt) {
    const pending = await getPortalPendingStore().create({ partnerId: pid, phone, purpose: 'consent' });
    return { step: 'consent', pending };
  }
  await completePortalSignIn(pid, phone, { totp });
  return 'signed_in';
}

/** Step 2: the WhatsApp code. */
export async function verifyCodeAction(_prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  const site = await requirePortalSite();
  const pid = site.partnerId;
  const pendingToken = field(formData, 'pending');
  const code = field(formData, 'code').replace(/\D/g, '');
  const pendingStore = getPortalPendingStore();

  let outcome: PortalLoginState | { ok: PortalPending };
  try {
    if (!(await ipAllowed(VERIFY_IP_LIMIT))) return { step: 'phone', error: 'portal.login.try_later' };
    const rec = await pendingStore.peek(pendingToken, pid, 'login');
    if (!rec) return { step: 'phone', error: 'portal.login.expired' };
    const last4 = rec.phone.slice(-4);
    if ((await pendingStore.countAttempt(pendingToken)) > PORTAL_PENDING_MAX_ATTEMPTS) {
      await pendingStore.consume(pendingToken);
      return { step: 'phone', error: 'portal.login.try_later' };
    }
    let result: Awaited<ReturnType<ReturnType<typeof getPortalOtpStore>['verify']>>;
    try {
      result = await getPortalOtpStore().verify(pid, rec.phone, code, 'login');
    } catch {
      result = { ok: false, reason: 'wrong' }; // a store error is a failed attempt, never success
    }
    if (!result.ok) {
      const phone = rec.phone;
      if (result.reason === 'locked') {
        await afterPortalResponse('portal.auth', () => audit(pid, phone, 'login_locked'));
        await pendingStore.consume(pendingToken);
        return { step: 'phone', error: 'portal.login.try_later' };
      }
      const reason = result.reason;
      await afterPortalResponse('portal.auth', () => audit(pid, phone, 'login_failure', { reason }));
      return { step: 'code', pending: pendingToken, last4, error: 'portal.login.code_invalid' };
    }
    await pendingStore.consume(pendingToken);
    outcome = { ok: rec };
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }

  const { phone } = outcome.ok;
  let enrolled = false;
  try {
    enrolled = await getCustomerMfaStore().isEnrolled({ partnerId: pid, phone });
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' }; // never skip a second factor on an error
  }
  if (enrolled) {
    try {
      const pending = await pendingStore.create({ partnerId: pid, phone, purpose: 'mfa' });
      return { step: 'mfa', pending };
    } catch {
      return { step: 'phone', error: 'portal.login.cant_send' }; // M2-14 (PR 394 L4): never a 500
    }
  }
  const next = await nextAfterProof(pid, phone);
  if (next !== 'signed_in') return next;
  redirect('/portal');
}

/** Step 2b (TOTP-enrolled customers): the authenticator code. */
export async function verifyMfaAction(_prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  const site = await requirePortalSite();
  const pid = site.partnerId;
  const pendingToken = field(formData, 'pending');
  const code = field(formData, 'code').replace(/\D/g, '');
  const pendingStore = getPortalPendingStore();

  // M2-14 (PR 394 L4): a Redis error on the way in answers cant_send, never a 500.
  let rec: PortalPending | null;
  let n: number;
  try {
    if (!(await ipAllowed(VERIFY_IP_LIMIT))) return { step: 'phone', error: 'portal.login.try_later' };
    rec = await pendingStore.peek(pendingToken, pid, 'mfa');
    if (!rec) return { step: 'phone', error: 'portal.login.expired' };
    n = await pendingStore.countAttempt(pendingToken);
    if (n > PORTAL_PENDING_MAX_ATTEMPTS) {
      await pendingStore.consume(pendingToken);
      return { step: 'phone', error: 'portal.login.try_later' };
    }
    // M2-14 (PR 394 L2): the per-(partner, phone) daily budget, reserved BEFORE the compare.
    if (!(await getPortalTotpBudget().reserve(pid, rec.phone))) {
      await pendingStore.consume(pendingToken);
      const phone = rec.phone;
      await afterPortalResponse('portal.auth', () => audit(pid, phone, 'login_locked', { factor: 'totp' }));
      return { step: 'phone', error: 'portal.login.try_later' };
    }
  } catch {
    return { step: 'phone', error: 'portal.login.cant_send' };
  }
  let ok = false;
  try {
    ok = /^\d{6}$/.test(code) && (await getCustomerMfaStore().verifyCode({ partnerId: pid, phone: rec.phone }, code));
  } catch {
    ok = false;
  }
  if (ok) {
    try {
      await getPortalTotpBudget().refund(pid, rec.phone); // only failures consume the budget
    } catch { /* the unit simply stays spent until the day ends */ }
  }
  if (!ok) {
    const phone = rec.phone;
    await afterPortalResponse('portal.auth', () => audit(pid, phone, 'mfa_failure'));
    if (n >= PORTAL_PENDING_MAX_ATTEMPTS) {
      await pendingStore.consume(pendingToken);
      return { step: 'phone', error: 'portal.login.try_later' };
    }
    return { step: 'mfa', pending: pendingToken, error: 'portal.login.mfa_invalid' };
  }
  await pendingStore.consume(pendingToken);
  const next = await nextAfterProof(pid, rec.phone, true);
  if (next !== 'signed_in') return next;
  redirect('/portal');
}

/**
 * Step 3 (first web sign-in only, owner O11): the customer agrees to WhatsApp transfer updates from
 * the partner and confirms the terms and privacy notice. Recorded as the WhatsApp opt-in plus an
 * audit row, BEFORE the first session. The customer row is created here, under the HOST partner.
 */
export async function consentAction(_prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  const site = await requirePortalSite();
  const pid = site.partnerId;
  const pendingToken = field(formData, 'pending');
  const pendingStore = getPortalPendingStore();

  if (!(await ipAllowed(VERIFY_IP_LIMIT))) return { step: 'phone', error: 'portal.login.try_later' };
  const rec = await pendingStore.peek(pendingToken, pid, 'consent');
  if (!rec) return { step: 'phone', error: 'portal.login.expired' };
  if (field(formData, 'consent') !== 'yes') {
    return { step: 'consent', pending: pendingToken, error: 'portal.login.consent_required' };
  }
  // Take the token ATOMICALLY before any write: a double submit gets one session, one audit pair.
  const taken = await pendingStore.take(pendingToken, pid, 'consent');
  if (!taken) return { step: 'phone', error: 'portal.login.expired' };
  const { phone } = taken;
  const repo = portalCustomers();
  const before = await repo.getCustomer(pid, phone);
  await repo.ensureCustomer(pid, phone); // under the HOST partner; no opt-in implied by itself
  if (!before) await audit(pid, phone, 'register');
  await repo.setOptedIn(pid, phone);
  await audit(pid, phone, 'consent', { whatsapp: true, terms: true });
  await completePortalSignIn(pid, phone);
  redirect('/portal');
}

/**
 * The login form's single entry point (one useActionState, progressive enhancement): the submit
 * button's `intent` picks the step. Each step action re-runs every gate itself.
 */
export async function portalLoginAction(prev: PortalLoginState | null, formData: FormData): Promise<PortalLoginState> {
  await requirePortalSite();
  switch (field(formData, 'intent')) {
    case 'verify':
      return verifyCodeAction(prev, formData);
    case 'resend':
      return resendCodeAction(prev, formData);
    case 'mfa':
      return verifyMfaAction(prev, formData);
    case 'consent':
      return consentAction(prev, formData);
    default:
      return requestCodeAction(prev, formData);
  }
}
