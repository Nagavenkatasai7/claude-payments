/**
 * portal-session-cookie — the customer portal's cookie name, lifetime policy and
 * cookie options (UI redesign M2-2). Kept free of `node:` imports and Redis so the
 * proxy and server actions can import it cheaply.
 *
 * `__Host-` prefix (RFC 6265bis): the browser accepts it only with Secure, Path=/
 * and NO Domain attribute, so the cookie is host-only. A cookie minted on one
 * partner's subdomain is never sent to another partner's subdomain or to the apex
 * (the cookie-no-domain scanner pins that no source sets a domain). The server
 * record is still bound to the partner (portal-session-store resolve), so a
 * replayed cookie is refused on the wrong host too.
 *
 * SameSite=Lax: a WhatsApp link opening the portal is a top-level cross-site GET
 * and must arrive signed in. POSTs from other sites carry no cookie.
 *
 * DIFFERENT name from the legacy `__Host-sr_session` (customer-session-cookie.ts),
 * so a legacy cookie is never read as a portal one.
 */

export const PORTAL_SESSION_COOKIE = '__Host-sr_portal';

const DAY_MS = 86_400_000;

/**
 * Session lifetimes (owner O1 + addendum):
 * - `idleMs` 30 days sliding, `absoluteMs` 90 days from sign-in whatever the activity;
 * - `cookieMaxAgeS` the browser cookie lifetime. Server actions re-set it clamped to the 90-day cap
 *   (`portalSessionCookieOptions(session)`); the proxy's sliding refresh on reads re-sets it UNCLAMPED
 *   (it has no session record), so the cookie can outlive the cap. The Redis record is the authority:
 *   its 90-day absolute cap refuses the session whatever the cookie says (M2-14, #394 L3);
 * - `stepUpFreshMs` 15 minutes: sensitive actions need a code verified this recently;
 * - `maxSessionsPerCustomer` live sessions per (partner, phone); the oldest are evicted.
 */
export const PORTAL_SESSION_POLICY = {
  idleMs: 30 * DAY_MS,
  absoluteMs: 90 * DAY_MS,
  cookieMaxAgeS: 30 * 86_400,
  stepUpFreshMs: 15 * 60_000,
  maxSessionsPerCustomer: 10,
} as const;

export interface PortalSessionCookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * Options for `cookies().set(PORTAL_SESSION_COOKIE, token, options)`. Exactly these
 * five attributes; host-only by construction (no domain key, ever).
 *
 * Given the session's `createdAtMs`, `maxAge` is clamped so the cookie never
 * outlives the 90-day absolute cap (0 once the cap has passed).
 */
export function portalSessionCookieOptions(
  session?: { createdAtMs: number },
  nowMs: number = Date.now(),
): PortalSessionCookieOptions {
  let maxAge: number = PORTAL_SESSION_POLICY.cookieMaxAgeS;
  if (session) {
    const remainingS = Math.floor((session.createdAtMs + PORTAL_SESSION_POLICY.absoluteMs - nowMs) / 1000);
    maxAge = Math.max(0, Math.min(maxAge, remainingS));
  }
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge };
}
