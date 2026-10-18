import { buildCsp } from '@/lib/csp';

// The CSP of the /oauth/authorize responses (Stage C1 spec item 13, the form-action trap).
//
// The consent form POSTs to /oauth/authorize (same origin), which answers 303 to the app's
// FOREIGN redirect_uri. Chromium-based browsers also check `form-action` against the redirects
// that follow a form submission (CSP Level 3, the form-action directive), so the site-wide
// `form-action 'self'` would block the hand-back. This route therefore sends its OWN policy
// (next.config.ts leaves this one path out of the global CSP header): the site policy, byte for
// byte, with exactly ONE extra form-action source, the origin of the redirect_uri the request
// was validated against. Anything that is not a plain origin adds nothing.

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export function isFormActionOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && (HTTPS_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin));
}

/** The site CSP with `form-action 'self' <origin>` when `origin` is a validated redirect origin. */
export function authorizeCsp(origin: string | null, isDev: boolean): string {
  const base = buildCsp({ isDev });
  if (!isFormActionOrigin(origin)) return base;
  return base.replace("form-action 'self'", `form-action 'self' ${origin}`);
}
