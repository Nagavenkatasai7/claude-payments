import { cache } from 'react';
import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { requirePortalSite, type PortalSite } from './portal-site';
import { getPortalSessionStore, PORTAL_SESSION_COOKIE, portalSessionCookieOptions, type PortalSession } from './portal-session-store';
import { getCustomerStore } from './customer-store';
import { getStore } from './store';
import { getCustomerMfaStore } from './customer-mfa';
import { deviceLabel } from './portal-device-label';
import { recordPortalAuthEventSafe } from './portal-auth-audit';
import { logWarn } from './log';
import type { Customer, PartnerId } from './types';

/**
 * portal-auth — the customer portal's session gate and sign-in completion (UI redesign M2-5,
 * Tasks 5.4/5.5). Identity is (host partner, phone): the partner ALWAYS comes from the Host
 * (requirePortalSite → getSiteTenant), the phone ALWAYS from the resolved session or the
 * server-side pending record. Never from a form field, a query or a cookie field.
 *
 * Cookies are written only in Server Functions (node_modules/next/dist/docs/01-app/03-api-reference/
 * 04-functions/cookies.md:74,81); redirect() throws, so callers invoke it outside any try block
 * (redirect.md:51).
 */

export interface PortalCustomerContext {
  customer: Customer;
  session: PortalSession;
  site: PortalSite;
  /** The cookie token (server-only; step-up and sign-out act on it). */
  token: string;
}

/** The customer-portal customer repo (tenant-keyed reads and writes only). */
export const portalCustomers = () => getCustomerStore(getStore());

async function loadPortalCustomer(): Promise<PortalCustomerContext | null> {
  const site = await requirePortalSite();
  const token = (await cookies()).get(PORTAL_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const session = await getPortalSessionStore().resolve(token, site.partnerId);
    if (!session) return null;
    const customer = await portalCustomers().getCustomer(site.partnerId, session.phone);
    if (!customer) return null;
    return { customer, session, site, token };
  } catch {
    return null; // a store error is "signed out", never "signed in"
  }
}

/** The signed-in customer on THIS partner's host, or null. A cookie from another partner's host is null. */
export const getPortalCustomer: () => Promise<PortalCustomerContext | null> = cache(loadPortalCustomer);

/** getPortalCustomer() or a redirect to the sign-in page. */
export async function requirePortalCustomer(): Promise<PortalCustomerContext> {
  const ctx = await getPortalCustomer();
  if (!ctx) redirect('/portal/login');
  return ctx;
}

/**
 * The step-up `next` allow-list: /portal or one of the sensitive pages, with opaque-id character sets
 * only (no `//`, no `..`, no query). Anything else → /portal.
 */
const NEXT_RE =
  /^\/portal(\/(send|send\/review|recipients|recipients\/new|recipients\/[0-9a-f]{32}\/edit|schedules|schedules\/new|transfers\/[A-Za-z0-9_-]{6,64}|notifications|devices|privacy))?$/;

export function safePortalNext(next: unknown): string {
  return typeof next === 'string' && NEXT_RE.test(next) ? next : '/portal';
}

/**
 * The 15-minute step-up rule (owner O1), answered without redirecting: true when the session's last
 * WhatsApp-code proof (and, for a TOTP-enrolled customer, last TOTP proof) is within 15 minutes.
 * Fails CLOSED: an unknown enrolment demands the TOTP proof, and any other error reads as not fresh.
 * requireFreshPortalAuth and the portal chat (/api/portal/chat) share this one rule.
 */
export async function isPortalSessionFresh(ctx: PortalCustomerContext): Promise<boolean> {
  let requireTotp = true; // unknown enrolment → demand the stronger proof (fail closed)
  try {
    requireTotp = await getCustomerMfaStore().isEnrolled({ partnerId: ctx.site.partnerId, phone: ctx.session.phone });
  } catch {
    /* keep true */
  }
  try {
    return getPortalSessionStore().isFresh(ctx.session, { requireTotp });
  } catch {
    return false;
  }
}

/**
 * The 15-minute step-up (owner O1). A session that is not fresh (isPortalSessionFresh) is sent
 * through /portal/verify first.
 */
export async function requireFreshPortalAuth(returnTo: string): Promise<PortalCustomerContext> {
  const ctx = await requirePortalCustomer();
  if (!(await isPortalSessionFresh(ctx))) {
    redirect(`/portal/verify?next=${safePortalNext(returnTo)}`);
  }
  return ctx;
}

/** Set the portal cookie: exactly the M2-2 options (host-only, no domain, ever). */
export async function setPortalCookie(token: string, session?: { createdAtMs: number }): Promise<void> {
  (await cookies()).set(PORTAL_SESSION_COOKIE, token, portalSessionCookieOptions(session));
}

/**
 * Clear the portal cookie. Written as an expired cookie WITH the __Host- attributes: a browser drops
 * a __Host- Set-Cookie that lacks Secure or Path=/, so a bare delete could leave it in place.
 */
export async function clearPortalCookie(): Promise<void> {
  (await cookies()).set(PORTAL_SESSION_COOKIE, '', { ...portalSessionCookieOptions(), maxAge: 0 });
}

/**
 * The last step of every sign-in (code, then TOTP and consent where needed): stamp the phone as
 * verified for THIS tenant row, rotate (the cookie presented at sign-in is destroyed), mint the
 * session, set the cookie, audit. The caller redirects afterwards.
 */
export async function completePortalSignIn(partnerId: PartnerId, phone: string, proof: { totp: boolean } = { totp: false }): Promise<void> {
  await portalCustomers().setPhoneVerifiedIfUnset(partnerId, phone);
  const jar = await cookies();
  const existing = jar.get(PORTAL_SESSION_COOKIE)?.value;
  const ua = (await headers()).get('user-agent');
  const store = getPortalSessionStore();
  const { token } = await store.create(partnerId, phone, deviceLabel(ua), existing);
  // A sign-in that proved the TOTP too stamps it, so the first sensitive action within 15 minutes
  // does not ask an enrolled customer for both factors again.
  if (proof.totp) await store.markStepUp(token, partnerId, { totp: true });
  await setPortalCookie(token);
  await recordPortalAuthEventSafe(getDb(), { partnerId, phone, event: 'login_success' });
}

/**
 * Run `task` AFTER the response has gone out (next/server `after`, which works in Server Functions:
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:8,10). Everything
 * phone-dependent on the unauthenticated path goes here, so neither the body nor the timing of the
 * response depends on the phone (review round 1, M1). Errors are caught and logged (fixed label, no
 * phone). With no request scope (tests, scripts) the task runs inline.
 */
export async function afterPortalResponse(label: string, task: () => Promise<void>): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch {
      logWarn(label, 'post-response task failed');
    }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}
