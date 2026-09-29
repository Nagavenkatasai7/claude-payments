'use server';

import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer, safePortalNext, afterPortalResponse } from '@/lib/portal-auth';
import { getPortalOtpStore, PORTAL_OTP_IP_LIMIT, type PortalVerifyResult } from '@/lib/portal-otp-store';
import { getPortalPendingStore, PORTAL_PENDING_MAX_ATTEMPTS, type PortalPending } from '@/lib/portal-pending-store';
import { getPortalSessionStore } from '@/lib/portal-session-store';
import { alertPortalOtpFailure, portalOtpChannelReady } from '@/lib/portal-otp-sender';
import { field, ipAllowed, issueAndSendAfterResponse, portalAudit, PORTAL_VERIFY_IP_LIMIT } from '@/lib/portal-login-flow';
import { getCustomerMfaStore } from '@/lib/customer-mfa';
import { getPortalTotpBudget } from '@/lib/portal-totp-budget';
import type { MessageKey } from '@/lib/i18n';

/**
 * The 15-minute step-up (UI redesign M2-5, Task 5.5; owner O1; review round 1, M4). The phone is the
 * SESSION's (never a form field) and every pending token is bound to the host partner AND to the
 * session id, so a step-up started in one session (or on another partner's host) cannot finish in
 * another. A TOTP-enrolled customer needs BOTH the WhatsApp code AND a TOTP code: the WhatsApp code
 * alone never marks the session fresh. The same after() discipline and the same one-copy failure
 * mapping as sign-in apply.
 */

export interface PortalStepUpState {
  step: 'start' | 'code' | 'mfa';
  /** The allow-listed return path (re-validated on every step). */
  next: string;
  pending?: string;
  notice?: MessageKey;
  error?: MessageKey;
}

/** The live step-up record for this session, or null. */
async function sessionPending(token: string, purpose: 'stepup' | 'stepup_totp', ctx: Awaited<ReturnType<typeof requirePortalCustomer>>) {
  const rec: PortalPending | null = await getPortalPendingStore().peek(token, ctx.site.partnerId, purpose);
  if (!rec || rec.sid !== ctx.session.sid || rec.phone !== ctx.session.phone) return null;
  return rec;
}

async function markFresh(ctx: Awaited<ReturnType<typeof requirePortalCustomer>>, totp: boolean, next: string): Promise<never> {
  const ok = await getPortalSessionStore().markStepUp(ctx.token, ctx.site.partnerId, { totp });
  if (!ok) redirect('/portal/login');
  await portalAudit(ctx.site.partnerId, ctx.session.phone, 'stepup_success', { totp });
  redirect(next);
}

/** Send a step-up code to the signed-in customer's own WhatsApp number. */
export async function stepUpRequestAction(_prev: PortalStepUpState | null, formData: FormData): Promise<PortalStepUpState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const next = safePortalNext(field(formData, 'next'));
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  let ipOk: boolean;
  try {
    ipOk = await ipAllowed(PORTAL_OTP_IP_LIMIT);
  } catch {
    return { step: 'start', next, error: 'portal.login.cant_send' };
  }
  const ready = await portalOtpChannelReady(pid);
  if (!ready.ready) {
    await afterPortalResponse('portal.otp', async () => {
      await portalAudit(pid, phone, 'otp_send_failed', { why: ready.why });
      await alertPortalOtpFailure(pid, ready.why);
    });
    return { step: 'start', next, error: 'portal.login.cant_send' };
  }
  let pending: string;
  try {
    pending = await getPortalPendingStore().create({ partnerId: pid, phone, purpose: 'stepup', sid: ctx.session.sid });
  } catch {
    return { step: 'start', next, error: 'portal.login.cant_send' }; // M2-14 (PR 394 L4): never a 500
  }
  await issueAndSendAfterResponse(pid, phone, 'stepup', ipOk, ready);
  return { step: 'code', next, pending, notice: 'portal.verify.codeSent' };
}

/** The WhatsApp step-up code. */
export async function stepUpVerifyAction(_prev: PortalStepUpState | null, formData: FormData): Promise<PortalStepUpState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const next = safePortalNext(field(formData, 'next'));
  const pid = ctx.site.partnerId;
  const pendingToken = field(formData, 'pending');
  const code = field(formData, 'code').replace(/\D/g, '');
  const store = getPortalPendingStore();

  if (!(await ipAllowed(PORTAL_VERIFY_IP_LIMIT))) return { step: 'start', next, error: 'portal.login.try_later' };
  const rec = await sessionPending(pendingToken, 'stepup', ctx);
  if (!rec) return { step: 'start', next, error: 'portal.login.expired' };
  if ((await store.countAttempt(pendingToken)) > PORTAL_PENDING_MAX_ATTEMPTS) {
    await store.consume(pendingToken);
    return { step: 'start', next, error: 'portal.login.try_later' };
  }
  let result: PortalVerifyResult;
  try {
    result = await getPortalOtpStore().verify(pid, rec.phone, code, 'stepup');
  } catch {
    result = { ok: false, reason: 'wrong' };
  }
  if (!result.ok) {
    const reason = result.reason;
    await afterPortalResponse('portal.auth', () => portalAudit(pid, rec.phone, 'stepup_failure', { reason }));
    if (reason === 'locked') {
      await store.consume(pendingToken);
      return { step: 'start', next, error: 'portal.login.try_later' };
    }
    return { step: 'code', next, pending: pendingToken, error: 'portal.login.code_invalid' };
  }
  await store.consume(pendingToken);

  let enrolled = true; // unknown → demand the TOTP too (fail closed)
  try {
    enrolled = await getCustomerMfaStore().isEnrolled({ partnerId: pid, phone: rec.phone });
  } catch {
    /* keep true */
  }
  if (enrolled) {
    try {
      const pending = await store.create({ partnerId: pid, phone: rec.phone, purpose: 'stepup_totp', sid: ctx.session.sid });
      return { step: 'mfa', next, pending };
    } catch {
      return { step: 'start', next, error: 'portal.login.cant_send' }; // M2-14 (PR 394 L4)
    }
  }
  return markFresh(ctx, false, next);
}

/** The TOTP half of an enrolled customer's step-up. */
export async function stepUpTotpAction(_prev: PortalStepUpState | null, formData: FormData): Promise<PortalStepUpState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const next = safePortalNext(field(formData, 'next'));
  const pid = ctx.site.partnerId;
  const pendingToken = field(formData, 'pending');
  const code = field(formData, 'code').replace(/\D/g, '');
  const store = getPortalPendingStore();

  // M2-14 (PR 394 L4): a Redis error on the way in answers cant_send, never a 500.
  let rec: PortalPending | null;
  let n: number;
  try {
    if (!(await ipAllowed(PORTAL_VERIFY_IP_LIMIT))) return { step: 'start', next, error: 'portal.login.try_later' };
    rec = await sessionPending(pendingToken, 'stepup_totp', ctx);
    if (!rec) return { step: 'start', next, error: 'portal.login.expired' };
    n = await store.countAttempt(pendingToken);
    if (n > PORTAL_PENDING_MAX_ATTEMPTS) {
      await store.consume(pendingToken);
      return { step: 'start', next, error: 'portal.login.try_later' };
    }
    // M2-14 (PR 394 L2): the same per-(partner, phone) daily budget as sign-in, reserved BEFORE the compare.
    if (!(await getPortalTotpBudget().reserve(pid, rec.phone))) {
      await store.consume(pendingToken);
      const phone = rec.phone;
      await afterPortalResponse('portal.auth', () => portalAudit(pid, phone, 'stepup_failure', { reason: 'totp_budget' }));
      return { step: 'start', next, error: 'portal.login.try_later' };
    }
  } catch {
    return { step: 'start', next, error: 'portal.login.cant_send' };
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
    await afterPortalResponse('portal.auth', () => portalAudit(pid, rec.phone, 'stepup_failure', { reason: 'totp' }));
    if (n >= PORTAL_PENDING_MAX_ATTEMPTS) {
      await store.consume(pendingToken);
      return { step: 'start', next, error: 'portal.login.try_later' };
    }
    return { step: 'mfa', next, pending: pendingToken, error: 'portal.login.mfa_invalid' };
  }
  await store.consume(pendingToken);
  return markFresh(ctx, true, next);
}

/** The step-up form's single entry point: the submit button's `intent` picks the step. */
export async function portalStepUpAction(prev: PortalStepUpState | null, formData: FormData): Promise<PortalStepUpState> {
  await requirePortalSite();
  switch (field(formData, 'intent')) {
    case 'verify':
      return stepUpVerifyAction(prev, formData);
    case 'mfa':
      return stepUpTotpAction(prev, formData);
    default:
      return stepUpRequestAction(prev, formData);
  }
}
