'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { requireCustomer } from '@/lib/customer-auth';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { getCustomerMfaStore, customerKey, recordCustomerMfaAudit } from '@/lib/customer-mfa';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';

/**
 * Program-Fix 49D (portal-03): TOTP enrolment for the signed-in customer, from
 * /account/settings. Public POST endpoints: each self-gates with
 * requireCustomer and acts ONLY on the session's own account (never a form
 * field). The secret is generated server-side, returned once in the action
 * state for the authenticator app (manual key + otpauth URI; no QR library),
 * held sealed in Redis for 10 minutes, and turned on only by a valid code.
 * It is never logged or audited. Mirrors 17b's staff enrolment
 * (src/app/admin-dashboard/account/actions.ts).
 */
export interface CustomerMfaEnrolState {
  ok: boolean;
  message?: string;
  secret?: string;
  uri?: string;
}

const UNAVAILABLE = 'Two-step verification is unavailable right now. Please try again later.';
const COOKIE_MAX_AGE = 12 * 60 * 60; // the session's absolute ceiling (same as actions.ts)

/**
 * Step 1. Re-proves the CURRENT password first, under the same
 * reserve-before-compare buckets as sign-in (fix 19), so a borrowed session
 * alone cannot bind its own authenticator to the account.
 */
export async function beginCustomerMfaEnrolmentAction(
  _prev: CustomerMfaEnrolState,
  formData: FormData,
): Promise<CustomerMfaEnrolState> {
  const customer = await requireCustomer();
  const current = String(formData.get('currentPassword') ?? '');
  if (!current) return { ok: false, message: 'Enter your current password.' };
  const phone = customer.senderPhone;
  const ip = clientIpFrom(await headers());
  const auth = getCustomerAuthStore();
  if (!(await auth.reserveLoginAttempt(phone, ip))) {
    return { ok: false, message: 'Too many attempts. Try again later.' };
  }
  const verified = await auth.verifyCustomerPassword(phone, current);
  // The proven account must be the SESSION's row (a phone can have a row per tenant).
  if (!verified || verified.partnerId !== customer.partnerId) {
    return { ok: false, message: 'Your current password is incorrect.' };
  }
  await auth.clearLoginFailures(phone, ip);
  try {
    const begun = await getCustomerMfaStore().beginEnrolment(customerKey(customer));
    if (!begun.ok) return { ok: false, message: 'Two-step verification is already on.' };
    return { ok: true, secret: begun.secretBase32, uri: begun.uri };
  } catch (err) {
    logWarn('customer.mfa', 'enrolment could not start', { error: err instanceof Error ? err.name : 'unknown' });
    return { ok: false, message: UNAVAILABLE };
  }
}

/** Step 2. One code from the app turns it on (at most 5 codes per setup). */
export async function confirmCustomerMfaEnrolmentAction(
  _prev: CustomerMfaEnrolState,
  formData: FormData,
): Promise<CustomerMfaEnrolState> {
  const customer = await requireCustomer();
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
  const key = customerKey(customer);
  let outcome;
  try {
    outcome = await getCustomerMfaStore().confirmEnrolment(key, code);
  } catch (err) {
    logWarn('customer.mfa', 'enrolment could not be confirmed', { error: err instanceof Error ? err.name : 'unknown' });
    return { ok: false, message: UNAVAILABLE };
  }
  switch (outcome) {
    case 'ok': {
      // Like a password change: every other session (possibly opened before
      // the second factor existed) is signed out; this browser gets a fresh one.
      const auth = getCustomerAuthStore();
      await auth.deleteAllSessions(customer.senderPhone);
      (await cookies()).set(CUSTOMER_SESSION_COOKIE, await auth.createSession(customer.senderPhone, customer.partnerId), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE,
      });
      try {
        await recordCustomerMfaAudit('customer.mfa.enroll', key);
      } catch (err) {
        logWarn('customer.mfa', 'enrolment audit write failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      revalidatePath('/account/settings');
      return {
        ok: true,
        message:
          'Two-step verification is on. Your other devices were signed out; you will be asked for a code from your app every time you sign in.',
      };
    }
    case 'invalid':
      return { ok: false, message: 'That code is not valid. Check the time on your phone and try again.' };
    case 'throttled':
      return { ok: false, message: 'Too many codes. Start the setup again.' };
    case 'enrolled':
      return { ok: false, message: 'Two-step verification is already on.' };
    default:
      return { ok: false, message: 'The setup expired. Start again.' };
  }
}
