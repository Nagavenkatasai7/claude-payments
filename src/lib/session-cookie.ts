// Isolated so middleware can import the cookie name without pulling in
// next/headers or the Redis client. Pure: every helper takes the jar.

/**
 * Program-Fix 45 P1 (crypto-10): the staff session cookie carries the
 * `__Host-` prefix, so a browser accepts it only with Secure, Path=/ and no
 * Domain (it cannot be planted by a sibling subdomain or over plain HTTP).
 */
export const SESSION_COOKIE = '__Host-sr_staff';
/**
 * The pre-45 cookie name. Still READ (a session minted before the rename, or by
 * the previous build during a rolling release, keeps working until it expires);
 * never written again, and expired on every login and logout.
 */
export const LEGACY_SESSION_COOKIE = 'sendhome_session';
/** 12 h: the staff session's absolute window (auth-store enforces it server-side). */
export const STAFF_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** The attributes a `__Host-` cookie needs; one definition for every writer. */
const HOST_COOKIE_ATTRS = { path: '/', secure: true } as const;

/** Structural slice of Next's cookie jars (next/headers `cookies()`, `req.cookies`). */
export interface StaffCookieReader {
  get(name: string): { value: string } | undefined;
}
/**
 * Structural slice of next/headers `cookies()` (ReadonlyRequestCookies =
 * Pick<ResponseCookies, 'set' | 'delete'>,
 * node_modules/next/dist/server/web/spec-extension/adapters/request-cookies.d.ts:5).
 */
export interface StaffCookieWriter {
  set(
    name: string,
    value: string,
    opts: { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number },
  ): unknown;
  /**
   * The OBJECT form (@edge-runtime/cookies index.d.ts:191). A bare-name delete
   * writes no Path or Secure (index.js:302-305), and a browser ignores such a
   * deletion for a `__Host-` cookie, leaving the session cookie in place.
   */
  delete(opts: { name: string; path: string; secure: boolean }): unknown;
}

/** Session tokens present on the request, the current cookie first. Empty values are skipped. */
export function staffSessionTokens(jar: StaffCookieReader): { token: string; legacy: boolean }[] {
  const out: { token: string; legacy: boolean }[] = [];
  const current = jar.get(SESSION_COOKIE)?.value;
  if (current) out.push({ token: current, legacy: false });
  const legacy = jar.get(LEGACY_SESSION_COOKIE)?.value;
  if (legacy) out.push({ token: legacy, legacy: true });
  return out;
}

/** True when the request carries either staff session cookie (the middleware's edge gate). */
export function hasStaffSessionCookie(jar: StaffCookieReader): boolean {
  return staffSessionTokens(jar).length > 0;
}

/** Write a freshly minted session token and expire the legacy cookie. */
export function setStaffSessionCookie(jar: StaffCookieWriter, token: string): void {
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: STAFF_SESSION_MAX_AGE_SECONDS,
    ...HOST_COOKIE_ATTRS,
  });
  jar.delete({ name: LEGACY_SESSION_COOKIE, ...HOST_COOKIE_ATTRS });
}

/** Expire both staff session cookies (logout). */
export function clearStaffSessionCookies(jar: StaffCookieWriter): void {
  jar.delete({ name: SESSION_COOKIE, ...HOST_COOKIE_ATTRS });
  jar.delete({ name: LEGACY_SESSION_COOKIE, ...HOST_COOKIE_ATTRS });
}
