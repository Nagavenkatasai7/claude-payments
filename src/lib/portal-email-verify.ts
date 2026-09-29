import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { EMAIL_MAX_LENGTH } from './customer-auth-store';
import { isValidSiteSlug } from './site-host';

/**
 * portal-email-verify — the customer portal's email address checks and single-use verify link
 * (UI redesign M2-11, Task 11.4).
 *
 * The link token is 256 bits (base64url, 43 chars). Redis holds ONLY `pev:<sha256(token)>` →
 * `{p, h, t}` (partner, phone, email tag; never the address, never the token) for 24 h. The tag is
 * emailVerifiedTag() (portal-prefs.ts), so a token is bound to the tenant, the customer AND the
 * address it was minted for: after an email change its tag no longer matches.
 *
 * Consumption is get → compare → getdel → compare-taken (the take-and-compare pattern of
 * customer-mfa confirmEnrolment): a submit on the wrong host or by the wrong customer reads and
 * refuses WITHOUT deleting, so it never burns the owner's token; only a matching submit takes it.
 * Nothing here logs the token or the address.
 */

export const PORTAL_EMAIL_TOKEN_TTL_S = 24 * 60 * 60;
/** Per customer: 5 email changes (each sends a verify email) per hour. */
export const PORTAL_EMAIL_LIMIT = { scope: 'portal-email', limit: 5, windowSec: 3600 } as const;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// RFC-5322-lite: one @, no whitespace, no list/quote/angle characters, a dot in the domain.
const EMAIL_RE = /^[^\s@,;<>"'()\\]+@[^\s@,;<>"'()\\]+\.[^\s@,;<>"'()\\]+$/;
const MASK = '•••'; // •••

/** The trimmed address, or null when it is not a plausible single address (≤ 254 chars). */
export function normalizePortalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > EMAIL_MAX_LENGTH || /[\r\n]/.test(v) || !EMAIL_RE.test(v)) return null;
  return v;
}

/** `u•••@example.com`: the first character and the domain only. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return MASK;
  const local = email.slice(0, at);
  return `${local.length > 1 ? local[0] : ''}${MASK}${email.slice(at)}`;
}

/** The verify link, on the partner's OWN host (never the apex, never a caller-supplied host). */
export function portalEmailVerifyUrl(slug: string, token: string): string {
  if (!isValidSiteSlug(slug)) throw new Error('portal-email-verify: invalid site slug');
  return `https://${slug}.smartremit.ai/portal/notifications/verify?token=${encodeURIComponent(token)}`;
}

export function isPortalEmailToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export interface EmailTokenBinding {
  partnerId: PartnerId;
  phone: string;
  tag: string;
}

const tokenKey = (token: string) => `pev:${createHash('sha256').update(token).digest('hex')}`;

/** Mint a token for (partner, phone, tag) and store only its hash. Returns the token (for the link). */
export async function mintEmailVerifyToken(redis: RedisLike, b: EmailTokenBinding): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(tokenKey(token), JSON.stringify({ p: b.partnerId, h: b.phone, t: b.tag }), { ex: PORTAL_EMAIL_TOKEN_TTL_S });
  return token;
}

function sameText(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function matches(raw: string | null, b: EmailTokenBinding): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const v = JSON.parse(raw) as { p?: unknown; h?: unknown; t?: unknown };
    return sameText(v.p, b.partnerId) && sameText(v.h, b.phone) && sameText(v.t, b.tag);
  } catch {
    return false;
  }
}

/**
 * True exactly once, for the (host partner, session phone, CURRENT email tag) the token was minted
 * for. Any mismatch leaves the token in place and returns false (one answer for every failure).
 */
export async function consumeEmailVerifyToken(redis: RedisLike, token: string, expect: EmailTokenBinding): Promise<boolean> {
  if (!isPortalEmailToken(token)) return false;
  const key = tokenKey(token);
  const raw = await redis.get(key);
  if (!matches(raw, expect)) return false;
  const taken = await redis.getdel(key);
  return taken === raw;
}
