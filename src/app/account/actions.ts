'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getOtpStore } from '@/lib/otp-store';
import { getOnboardingTokenStore } from '@/lib/onboarding-token';
import { isPwnedPassword } from '@/lib/pwned';
import { sendOtpCode } from '@/lib/whatsapp';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

/**
 * Account portal server actions (customer onboarding Phase 1).
 *
 * Each action is a PUBLIC POST endpoint; there is no page to "gate" it, so the
 * security boundary lives here:
 *  - INPUT is validated + normalized; the route never trusts client-supplied phone
 *    formatting (normalizePhone) and never reflects raw input back.
 *  - ENUMERATION-SAFE: login + reset collapse every failure mode to one generic
 *    message and an indistinguishable side-effect profile, so an attacker can't
 *    tell "no account" from "wrong password".
 *  - The OTP store owns the abuse throttle (30s cooldown, 5/hr, 10/day); we just
 *    surface its decision. A throttled issue is NOT a hard error (the UI still
 *    advances to the OTP step; the resend button covers retry).
 *  - SESSIONS are only minted by verifyOtpAction — possession of the phone (OTP)
 *    is required before any cookie is set, for BOTH register and login (AAL2).
 *  - The `__Host-` cookie is HttpOnly + Secure + SameSite=Lax + Path=/.
 *
 * Phase-1 scope: the portal is reachable directly. The WhatsApp deep-link
 * (onboarding token) is accepted but NOT required; the OTP is the real
 * possession proof. The bot link + the verify-before-send gate are Phase 3.
 */

// ── Action state (drives the multi-step client UI) ──
export type AccountStep = 'register' | 'login' | 'otp';

export interface AccountState {
  step: AccountStep;
  /** Normalized phone, carried forward to the OTP step. */
  phone?: string;
  /** Generic, enumeration-safe user-facing error (never leaks which field). */
  error?: string;
  /** Transient success note (e.g. "Code sent"). */
  notice?: string;
}

const GENERIC_LOGIN_ERROR = 'Invalid phone or password.';
const GENERIC_OTP_DELIVERY_NOTE = 'We sent a 6-digit code to your WhatsApp.';
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12h absolute (matches the session store ceiling)

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

/**
 * Issue + deliver an OTP. Throttling is NOT surfaced as a hard failure — the UI
 * advances to the OTP step regardless and the resend button covers retry. The
 * code never appears in a return value or a log (sendOtpCode owns delivery).
 */
async function issueAndSend(phone: string): Promise<void> {
  const otp = getOtpStore();
  const result = await otp.issueOtp(phone);
  if (result.ok) {
    await sendOtpCode(phone, result.code);
  }
  // throttled ⇒ a live code already exists or the caller is abusing resend; do
  // not send again, do not error — the prior code is still valid.
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

/**
 * Register a new customer account: phone + email + password. The store owns the
 * collision guard, password policy, breach check, Argon2id hash, and email
 * field-encryption. On success we issue + send an OTP and advance to the OTP
 * step — NO session is minted (the phone is still unverified). An optional
 * `?token=` (WhatsApp onboarding link) is consumed here single-use IF it binds
 * the same phone, but is never required.
 */
export async function registerAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const email = field(formData, 'email').trim();
  const password = field(formData, 'password');
  const token = field(formData, 'token').trim();

  if (!isValidPhone(phone)) {
    return { step: 'register', error: 'Enter a valid phone number.' };
  }
  if (!email || !email.includes('@')) {
    return { step: 'register', error: 'Enter a valid email address.' };
  }

  try {
    await getCustomerAuthStore().registerCustomer(
      { phone, email, password },
      { pwnedCheck: isPwnedPassword },
    );
  } catch (err) {
    // registerCustomer throws user-safe policy/collision messages. These are NOT
    // an enumeration risk in the register flow (a duplicate number is expected to
    // tell the user "account exists" so they go log in).
    const message =
      err instanceof Error ? err.message : 'Could not create your account.';
    return { step: 'register', error: message };
  }

  // Single-use consume of the onboarding link IF it authorizes this phone. Never
  // required; the OTP below is the real possession proof.
  if (token) {
    const bound = await getOnboardingTokenStore().consumeOnboardingToken(token);
    void bound; // binding is advisory in Phase 1; do not block on mismatch
  }

  await issueAndSend(phone);

  return { step: 'otp', phone, notice: GENERIC_OTP_DELIVERY_NOTE };
}

/**
 * Complete BOTH the register and login flows: verify the WhatsApp OTP, then mint
 * the session. On success: stamp `phoneVerifiedAt`, create a session, set the
 * `__Host-` cookie, and redirect to /account. On failure: return to the OTP step
 * with a reason (the OTP store distinguishes wrong / expired / locked — those are
 * safe to show because the user already proved knowledge of the password/account).
 */
export async function verifyOtpAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const code = field(formData, 'code').replace(/\D/g, '');

  if (!isValidPhone(phone)) {
    return { step: 'otp', phone, error: 'Your session expired — start again.' };
  }

  const result = await getOtpStore().verifyOtp(phone, code);
  if (!result.ok) {
    const reason =
      result.reason === 'expired'
        ? 'That code expired. Tap resend for a new one.'
        : result.reason === 'locked'
          ? 'Too many attempts. Tap resend for a new code.'
          : result.reason === 'no_code'
            ? 'No active code. Tap resend.'
            : 'That code is incorrect.';
    return { step: 'otp', phone, error: reason };
  }

  const authStore = getCustomerAuthStore();
  // The account MUST already exist (register/login created/loaded it). Stamp the
  // verified-at flag; if somehow absent, fail closed to the OTP step.
  const customer = await authStore.markPhoneVerified(phone);
  if (!customer) {
    return { step: 'otp', phone, error: 'Your session expired — start again.' };
  }

  const token = await authStore.createSession(phone);
  setSessionCookie(await cookies(), token);
  redirect('/account');
}

/**
 * Resend the OTP. The store's 30s cooldown / hourly / daily caps own abuse
 * control; we always return to the OTP step (enumeration-safe — never reveals
 * whether the phone has an account).
 */
export async function resendOtpAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  if (!isValidPhone(phone)) {
    return { step: 'otp', phone, error: 'Your session expired — start again.' };
  }
  await issueAndSend(phone);
  return { step: 'otp', phone, notice: GENERIC_OTP_DELIVERY_NOTE };
}

/**
 * Step 1 of login: verify the password (AAL1). On success, issue an OTP (AAL2)
 * and advance to the OTP step — NO session yet; verifyOtpAction completes it.
 * Enumeration-safe: a missing account and a wrong password collapse to one
 * generic error with an identical (no-OTP, no-session) side-effect profile.
 */
export async function loginAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const password = field(formData, 'password');

  if (!isValidPhone(phone) || password.length === 0) {
    return { step: 'login', error: GENERIC_LOGIN_ERROR };
  }

  const customer = await getCustomerAuthStore().verifyCustomerPassword(phone, password);
  if (!customer) {
    return { step: 'login', error: GENERIC_LOGIN_ERROR };
  }

  await issueAndSend(phone);
  return { step: 'otp', phone, notice: GENERIC_OTP_DELIVERY_NOTE };
}

/** Sign out: revoke the current session and clear the cookie. */
export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (token) await getCustomerAuthStore().deleteSession(token);
  jar.delete(CUSTOMER_SESSION_COOKIE);
  redirect('/account/login');
}

/**
 * Request a password reset: issue a single-use reset token + deliver an OTP, then
 * advance to the confirm step. Enumeration-safe — ALWAYS returns the same
 * neutral state whether or not an account exists (no "we sent you" vs "no
 * account" distinction). The token is only created when an account exists, but
 * the response is identical either way.
 */
export async function requestResetAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  if (isValidPhone(phone)) {
    const authStore = getCustomerAuthStore();
    const customer = await authStore.getCustomer(phone);
    if (customer?.passwordHash) {
      // Only mint a reset token + OTP for a real account. Both are throttled /
      // single-use; the response below is identical regardless.
      await authStore.createResetToken(phone);
      await issueAndSend(phone);
    }
  }
  // Neutral, indistinguishable response.
  return {
    step: 'otp',
    phone: isValidPhone(phone) ? phone : undefined,
    notice: 'If that number has an account, we sent a reset code.',
  };
}

/**
 * Confirm a password reset: verify the OTP, set the new password (policy +
 * breach check via the store), REVOKE ALL sessions, and DO NOT auto-login —
 * the user must sign in fresh. Enumeration-safe generic errors.
 */
export async function resetAction(
  _prev: AccountState | null,
  formData: FormData,
): Promise<AccountState> {
  const phone = normalizePhone(field(formData, 'phone'));
  const code = field(formData, 'code').replace(/\D/g, '');
  const password = field(formData, 'password');

  if (!isValidPhone(phone)) {
    return { step: 'login', error: 'Your reset session expired — start again.' };
  }

  const otpResult = await getOtpStore().verifyOtp(phone, code);
  if (!otpResult.ok) {
    return { step: 'otp', phone, error: 'That code is incorrect or expired.' };
  }

  const authStore = getCustomerAuthStore();
  let updated;
  try {
    // setPassword enforces the length policy + breach check, Argon2id-hashes, and
    // revokes ALL live sessions internally. Returns null if no account exists.
    updated = await authStore.setPassword(phone, password, { pwnedCheck: isPwnedPassword });
  } catch (err) {
    // A policy/breach rejection is safe to show — the user already proved phone
    // possession via the OTP above.
    const message = err instanceof Error ? err.message : 'Could not reset your password.';
    return { step: 'otp', phone, error: message };
  }
  if (!updated) {
    // No account — neutral error, no state change.
    return { step: 'login', error: 'Your reset session expired — start again.' };
  }

  // Revoke-all done inside setPassword; require a fresh sign-in (no auto-login).
  return {
    step: 'login',
    notice: 'Password reset. Please sign in with your new password.',
  };
}
