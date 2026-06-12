'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCustomerAuthStore, CustomerInputError } from '@/lib/customer-auth-store';
import { getOtpStore, type OtpPurpose } from '@/lib/otp-store';
import { getPendingAuthStore } from '@/lib/pending-auth-store';
import { getOnboardingTokenStore } from '@/lib/onboarding-token';
import { isPwnedPassword } from '@/lib/pwned';
import { sendOtpCode } from '@/lib/whatsapp';
import { logWarn } from '@/lib/log';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { getDb } from '@/db/client';
import { pokeWorker } from '@/lib/outbox';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { encryptField, defaultProvider } from '@/lib/field-crypto';

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
  if (await auth.isOtpIpLocked(ip)) {
    // Silent to the CALLER (enumeration safety) but never to ops — a locked IP
    // during legitimate testing looks exactly like "the code never arrives".
    logWarn('otp.issue', 'per-IP send cap hit — no code sent', { purpose });
    return;
  }
  const result = await getOtpStore().issueOtp(phone, purpose);
  if (!result.ok) {
    logWarn('otp.issue', `refused: ${result.reason}`, { purpose, phone });
    return;
  }
  try {
    await sendOtpCode(phone, result.code);
    await auth.recordOtpIp(ip);
  } catch (err) {
    // Delivery failure must NOT 500 the portal and the UI stays generic, but
    // it must be LOUD for ops: this is the "verification code never arrives"
    // symptom. Scrubbed log + one deduped WhatsApp ops alert per hour. The
    // root cause is usually one of: no approved AUTHENTICATION template
    // (WHATSAPP_AUTH_TEMPLATE) AND the customer is outside the free-form 24h
    // window. Never log the code.
    logWarn('otp.deliver', err, { purpose, phone });
    try {
      await createOutboxRepo(getDb()).enqueue(
        'ops.alert',
        {
          message:
            '⚠️ SmartRemit ops: portal OTP delivery is FAILING (template + free-form both rejected). ' +
            'Check WHATSAPP_AUTH_TEMPLATE approval in WhatsApp Manager.',
        },
        { dedupeKey: `otpfail:${new Date().toISOString().slice(0, 13)}` }, // 1/hour
      );
      pokeWorker();
    } catch {
      /* alerting is best-effort */
    }
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
    // Only reflect intentional validation/policy messages. Any other throw — a
    // crypto/env misconfig (e.g. an unset FIELD_ENCRYPTION_KEY), an Argon2
    // failure, a Redis outage — is internal and must NOT leak to the customer.
    if (err instanceof CustomerInputError) {
      return { step: 'register', error: err.message };
    }
    console.error('registerAction: unexpected failure', err);
    return { step: 'register', error: 'Could not create your account. Please try again.' };
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
    if (err instanceof CustomerInputError) {
      return { step: 'otp', phone, pendingToken, error: err.message };
    }
    console.error('resetAction: unexpected failure', err);
    return { step: 'otp', phone, pendingToken, error: 'Could not reset your password. Please try again.' };
  }
  if (!updated) return { step: 'login', error: SESSION_EXPIRED };

  await getPendingAuthStore().consume(pendingToken); // single-use
  return { step: 'login', notice: 'Password reset. Please sign in with your new password.' };
}

// ── Settings (customer dashboard B1) ────────────────────────────────────────
//
// Both actions self-gate with requireCustomer() (server actions are PUBLIC
// POST endpoints) and derive the target account FROM THE SESSION — no phone
// ever comes from the form. Results travel as FIXED query-param codes that the
// settings page maps to fixed copy, so no dynamic text (and no internal error
// detail) is ever reflected into the page.

const SETTINGS_PATH = '/account/settings';

/** Update the account email (re-encrypted at rest, same as registration). */
export async function updateEmailAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();
  const email = field(formData, 'email').trim();
  if (!email || !email.includes('@') || email.length > 254) {
    redirect(`${SETTINGS_PATH}?err=email`);
  }

  let dest = `${SETTINGS_PATH}?ok=email`;
  try {
    // Re-read inside the action so a concurrent KYC/consent write between the
    // page render and this POST is never clobbered by a stale session copy.
    const customers = getCustomerStore(getStore());
    const fresh = await customers.getCustomer(customer.senderPhone);
    if (!fresh) {
      dest = `${SETTINGS_PATH}?err=email_save`;
    } else {
      const nowIso = new Date().toISOString();
      await customers.saveCustomer({
        ...fresh,
        email: encryptField(email, defaultProvider()),
        updatedAt: nowIso,
      });
    }
  } catch (err) {
    // Crypto/env/DB failures are internal — never reflected (logger scrubs).
    logWarn('settings.email', err);
    dest = `${SETTINGS_PATH}?err=email_save`;
  }
  redirect(dest);
}

/**
 * Change the password: verify the CURRENT password first (under the same
 * brute-force lock as login — this is the same guessing surface, just behind a
 * session), then set the new one. setPassword revokes EVERY live session, so
 * on success this device's session is re-minted in place.
 */
export async function changePasswordAction(formData: FormData): Promise<void> {
  const customer = await requireCustomer();
  const phone = customer.senderPhone;
  const current = field(formData, 'currentPassword');
  const next = field(formData, 'newPassword');
  const ip = await clientIp();
  const auth = getCustomerAuthStore();

  if (current.length === 0 || next.length === 0) {
    redirect(`${SETTINGS_PATH}?err=pw_current`);
  }
  if (await auth.isLoginLocked(phone, ip)) {
    redirect(`${SETTINGS_PATH}?err=pw_throttle`);
  }
  const verified = await auth.verifyCustomerPassword(phone, current);
  if (!verified) {
    await auth.recordLoginFailure(phone, ip);
    redirect(`${SETTINGS_PATH}?err=pw_current`);
  }
  await auth.clearLoginFailures(phone);

  let dest = `${SETTINGS_PATH}?ok=password`;
  try {
    const updated = await auth.setPassword(phone, next, { pwnedCheck: isPwnedPassword });
    if (!updated) {
      dest = `${SETTINGS_PATH}?err=pw_save`;
    } else {
      // setPassword revoked all sessions (every device) — re-mint THIS one so a
      // password change doesn't read as being logged out.
      const token = await auth.createSession(phone);
      setSessionCookie(await cookies(), token);
    }
  } catch (err) {
    if (err instanceof CustomerInputError) {
      // Policy refusal (length / breach) → one fixed code; the page shows the
      // combined policy copy rather than reflecting dynamic text.
      dest = `${SETTINGS_PATH}?err=pw_policy`;
    } else {
      logWarn('settings.password', err);
      dest = `${SETTINGS_PATH}?err=pw_save`;
    }
  }
  redirect(dest);
}
