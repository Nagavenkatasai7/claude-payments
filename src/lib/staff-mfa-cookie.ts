import type { StaffCookieReader, StaffCookieWriter } from './session-cookie';

/**
 * Program-Fix 17b: the sign-in's pending second step. Holds a random token
 * (Redis keeps only its sha256, staff-mfa-store) for 5 minutes between a
 * proven password and the TOTP code. `__Host-` like the session cookie
 * (Secure, Path=/, no Domain); httpOnly. It carries no authority by itself:
 * the /login/mfa action still needs a valid, unused code for that username.
 */
export const MFA_PENDING_COOKIE = '__Host-sr_staff_mfa';
export const MFA_PENDING_MAX_AGE_SECONDS = 5 * 60;

export function readMfaPendingToken(jar: StaffCookieReader): string {
  return jar.get(MFA_PENDING_COOKIE)?.value ?? '';
}

export function setMfaPendingCookie(jar: StaffCookieWriter, token: string): void {
  jar.set(MFA_PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MFA_PENDING_MAX_AGE_SECONDS,
    path: '/',
    secure: true,
  });
}

export function clearMfaPendingCookie(jar: StaffCookieWriter): void {
  jar.delete({ name: MFA_PENDING_COOKIE, path: '/', secure: true });
}
