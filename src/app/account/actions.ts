'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getOtpStore, type OtpPurpose } from '@/lib/otp-store';
import { getPendingAuthStore } from '@/lib/pending-auth-store';
import { getOnboardingTokenStore } from '@/lib/onboarding-token';
import { isPwnedPassword } from '@/lib/pwned';
import { sendOtpCode } from '@/lib/whatsapp';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

/**
 * Account portal server actions (customer onboarding Phase 1) — AAL2.
 *
 * The security spine (each action is a PUBLIC POST endpoint, no page gates it):
 *  - Input validated + normalized; raw input never reflected.
 *  - ENUMERATION-SAFE: login + reset collapse every failure to one generic
 *    message with an indistinguishable side-effect profile.
 *  - TWO-FACTOR BINDING: a session is minted ONLY by verifyOtpAction, and ONLY
 *    after consuming a single-use PENDING-AUTH token that was minted earlier —
 *    'login' (after the password check), 'register' (after account creation), or
 *    'reset' (reset request). The OTP step derives the phone FROM THE TOKEN, not
 *    the form, so a valid OTP alone can't authenticate, and a 'reset' code can't
 *    log anyone in (purpose mismatch + purpose-namespaced OTP).
 *  - BRUTE FORCE: per-phone/day + per-IP/hour login lockout; per-IP OTP-send cap;
 *    plus the OTP store's per-number caps + daily fail lock.
 *  - The `__Host-` cookie is HttpOnly + Secure + SameSite=Lax + Path=/.
 */

export type AccountStep = 'register' | 'login' | 'otp';

export interface AccountState {
  step: AccountStep;
  phone?: string;
  /** Single-use pending-auth token carried into the OTP/reset step (hidden field). */
  pendingToken?: string;
  error?: string;
  notice?: string;
}

const GENERIC_LOGIN_ERROR = 'Invalid phone or password.';
const GENERIC_OTP_NOTE = 'We sent a 6-digit code to your WhatsApp.';
const SESSION_EXPIRED = 'Your session expired — please start again.';
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12h absolute (matches the session ceiling)

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for') ?? '';
  return fwd.split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
}

/**
 * Issue + deliver an OTP for a (phone, purpose). Per-IP send cap blunts
 * number-rotation pumping; the OTP store owns the per-number caps + geo + daily
 * fail lock. Throttling is never a hard error (the UI advances; resend retries).
 * The code never appears in a return value or a log.
 */
async function issueAndSend(phone: string, purpose: OtpPurpose, ip: string): Promise<void> {
  const auth = getCustomerAuthStore();
  if (await auth.isOtpIpLocked(ip)) return; // silent — don't reveal the throttle
  const result = await getOtpStore().issueOtp(phone, purpose);
  if (result.ok) {
    await sendOtpCode(phone, result.code);
    await auth.recordOtpIp(ip);
  }
}

function setSessionCookie(jar: Awaited<ReturnType<typeof cookies>>, token: string): void {
  jar.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Register: store owns collision/policy/breach/Argon2id/email-encryption. On
 * success, mint a 'register' pending-auth token + send an OTP → OTP step. No
 * session yet (phone unverified). An optional onboarding `?token=` is consumed
 * single-use if present, but is never required. */
export async function registerAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const email = field(formData, 'email').trim();
  const password = field(formData, 'password');
  const onboardToken = field(formData, 'token').trim();
  const ip = await clientIp();

  if (!isValidPhone(phone)) return { step: 'register', error: 'Enter a valid phone number.' };
  if (!email || !email.includes('@')) return { step: 'register', error: 'Enter a valid email address.' };

  try {
    await getCustomerAuthStore().registerCustomer(
      { phone, email, password },
      { pwnedCheck: isPwnedPassword },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not create your account.';
    return { step: 'register', error: message };
  }

  if (onboardToken) {
    await getOnboardingTokenStore().consumeOnboardingToken(onboardToken); // advisory in Phase 1
  }

  const pendingToken = await getPendingAuthStore().create(phone, 'register');
  await issueAndSend(phone, 'register', ip);
  return { step: 'otp', phone, pendingToken, notice: GENERIC_OTP_NOTE };
}

/** Login step 1: verify the password (AAL1) under a per-phone/IP brute-force
 * lock. On success, mint a 'login' pending-auth token + OTP → OTP step. No
 * session yet. Enumeration-safe: every failure → one generic error, no OTP. */
export async function loginAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const password = field(formData, 'password');
  const ip = await clientIp();
  const auth = getCustomerAuthStore();

  if (!isValidPhone(phone) || password.length === 0) {
    return { step: 'login', error: GENERIC_LOGIN_ERROR };
  }
  // Lockout BEFORE doing the (expensive) Argon2id verify — fail-closed, generic.
  if (await auth.isLoginLocked(phone, ip)) {
    return { step: 'login', error: GENERIC_LOGIN_ERROR };
  }

  const customer = await auth.verifyCustomerPassword(phone, password);
  if (!customer) {
    await auth.recordLoginFailure(phone, ip);
    return { step: 'login', error: GENERIC_LOGIN_ERROR };
  }
  await auth.clearLoginFailures(phone);

  const pendingToken = await getPendingAuthStore().create(phone, 'login');
  await issueAndSend(phone, 'login', ip);
  return { step: 'otp', phone, pendingToken, notice: GENERIC_OTP_NOTE };
}

/** Login/register step 2: consume the pending-auth token (proves the prior
 * factor), verify the purpose-matched OTP, then mint the session. The phone is
 * derived FROM THE TOKEN, never the form. */
export async function verifyOtpAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const pendingToken = field(formData, 'pendingToken');
  const code = field(formData, 'code').replace(/\D/g, '');

  const pending = await getPendingAuthStore().peek(pendingToken);
  // Only 'login'/'register' tokens may mint a session here; a 'reset' token can't.
  if (!pending || (pending.purpose !== 'login' && pending.purpose !== 'register')) {
    return { step: 'login', error: SESSION_EXPIRED };
  }
  const phone = pending.phone;

  const result = await getOtpStore().verifyOtp(phone, code, pending.purpose);
  if (!result.ok) {
    const reason =
      result.reason === 'expired'
        ? 'That code expired. Tap resend for a new one.'
        : result.reason === 'locked'
          ? 'Too many attempts. Tap resend for a new code.'
          : result.reason === 'no_code'
            ? 'No active code. Tap resend.'
            : 'That code is incorrect.';
    return { step: 'otp', phone, pendingToken, error: reason };
  }

  // OTP correct → consume the pending token (single-use), stamp verified, session.
  await getPendingAuthStore().consume(pendingToken);
  const authStore = getCustomerAuthStore();
  const customer = await authStore.markPhoneVerified(phone);
  if (!customer) return { step: 'login', error: SESSION_EXPIRED };

  const token = await authStore.createSession(phone);
  setSessionCookie(await cookies(), token);
  redirect('/account');
}

/** Resend the OTP for the in-flight pending-auth token (does NOT consume it). */
export async function resendOtpAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const pendingToken = field(formData, 'pendingToken');
  const pending = await getPendingAuthStore().peek(pendingToken);
  if (!pending) return { step: 'login', error: SESSION_EXPIRED };
  await issueAndSend(pending.phone, pending.purpose as OtpPurpose, await clientIp());
  return { step: 'otp', phone: pending.phone, pendingToken, notice: GENERIC_OTP_NOTE };
}

/** Sign out: revoke the current session + clear the cookie. */
export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (token) await getCustomerAuthStore().deleteSession(token);
  jar.delete(CUSTOMER_SESSION_COOKIE);
  redirect('/account/login');
}

/** Request a reset: for a real account, mint a 'reset' pending-auth token + OTP.
 * Enumeration-safe — identical neutral response regardless of account existence. */
export async function requestResetAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const ip = await clientIp();
  let pendingToken: string | undefined;
  if (isValidPhone(phone)) {
    const auth = getCustomerAuthStore();
    const customer = await auth.getCustomer(phone);
    if (customer?.passwordHash) {
      pendingToken = await getPendingAuthStore().create(phone, 'reset');
      await issueAndSend(phone, 'reset', ip);
    }
  }
  return {
    step: 'otp',
    phone: isValidPhone(phone) ? phone : undefined,
    pendingToken,
    notice: 'If that number has an account, we sent a reset code.',
  };
}

/** Confirm a reset: consume the 'reset' pending-auth token, verify the
 * reset-purpose OTP, set the new password (revokes all sessions), NO auto-login. */
export async function resetAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const pendingToken = field(formData, 'pendingToken');
  const code = field(formData, 'code').replace(/\D/g, '');
  const password = field(formData, 'password');

  const pending = await getPendingAuthStore().peek(pendingToken);
  if (!pending || pending.purpose !== 'reset') {
    return { step: 'login', error: SESSION_EXPIRED };
  }
  const phone = pending.phone;

  const otpResult = await getOtpStore().verifyOtp(phone, code, 'reset');
  if (!otpResult.ok) {
    return { step: 'otp', phone, pendingToken, error: 'That code is incorrect or expired.' };
  }

  const authStore = getCustomerAuthStore();
  let updated;
  try {
    updated = await authStore.setPassword(phone, password, { pwnedCheck: isPwnedPassword });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not reset your password.';
    return { step: 'otp', phone, pendingToken, error: message };
  }
  if (!updated) return { step: 'login', error: SESSION_EXPIRED };

  await getPendingAuthStore().consume(pendingToken); // single-use
  return { step: 'login', notice: 'Password reset. Please sign in with your new password.' };
}
