// referral-code — Batch B4. The referral code format and the portal referral cookie, with NO
// imports, so the proxy (src/proxy.ts) can use it cheaply. src/lib/referrals.ts re-exports the
// code helpers for everything else.

/** `REF-` plus 6 letters or digits (generated codes avoid 0/O/1/I; an admin may hand out REF-TANA01). */
export const REFERRAL_CODE_RE = /^REF-[A-Z0-9]{6}$/;
const CODE_IN_TEXT_RE = /(?<![A-Za-z0-9-])REF-[A-Za-z0-9]{6}(?![A-Za-z0-9])/i;

/** A trimmed, upper-cased code, or null when it is not `REF-` + 6 letters or digits. */
export function normalizeReferralCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(s) ? s : null;
}

/** The first standalone code in a customer's message (any case), upper-cased; null when none. */
export function findReferralCodeInText(text: string): string | null {
  const m = CODE_IN_TEXT_RE.exec(text ?? '');
  return m ? m[0].toUpperCase() : null;
}

// ── The portal referral cookie ──────────────────────────────────────────────
// /portal/login?ref=REF-XXXXXX keeps the code for 30 days so a customer who signs up later
// is still linked. Pages cannot set cookies (node_modules/next/dist/docs/01-app/03-api-reference/
// 04-functions/cookies.md:74,81), so the proxy sets it on the GET of the sign-in page. HttpOnly,
// SameSite=Lax (the link is a top-level cross-site GET), Secure in production, host-only (no
// Domain, like every cookie here). It holds only a format-checked code, never personal data.

export const REFERRAL_COOKIE = 'sr_ref';
export const REFERRAL_COOKIE_MAX_AGE_S = 30 * 86_400;
export const REFERRAL_LOGIN_PATH = '/portal/login';

export interface ReferralCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export function referralCookieOptions(production: boolean = process.env.NODE_ENV === 'production'): ReferralCookieOptions {
  return { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: REFERRAL_COOKIE_MAX_AGE_S };
}

/**
 * The code the proxy should store for this request, or null. Only a GET/HEAD of the portal sign-in
 * page with a well-formed `ref`, and only when no well-formed code is stored yet (first touch wins,
 * like the attribution itself).
 */
export function referralCodeToStore(req: { method: string; pathname: string; ref: string | null; existing: string | undefined }): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.pathname !== REFERRAL_LOGIN_PATH) return null;
  const code = normalizeReferralCode(req.ref);
  if (!code) return null;
  if (normalizeReferralCode(req.existing)) return null;
  return code;
}
