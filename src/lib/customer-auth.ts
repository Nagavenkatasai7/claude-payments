import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Customer } from './types';
import { getCustomerAuthStore } from './customer-auth-store';
import { CUSTOMER_SESSION_COOKIE } from './customer-session-cookie';
import { customerPortalOrigin, portalUrl } from './customer-portal-url';

/**
 * Resolve the logged-in Customer from the `__Host-sr_session` cookie, or null.
 * Mirrors auth.ts getCurrentStaff: cookie → session store → entity load. The
 * Customer read goes through the same customer-auth-store seam (one mock point).
 */
export async function getCurrentCustomer(): Promise<Customer | null> {
  const token = (await cookies()).get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;
  // The session carries (tenant, phone) — fix 1: a phone alone is not an identity.
  return getCustomerAuthStore().resolveSession(token);
}

/**
 * The signed-in legacy /account customer, or a redirect to /account/login.
 *
 * One customer portal (Oct 2): a page passes `portalPath`, its matching page in the customer portal.
 * When the customer's OWN partner (from the session, never the URL) runs a live portal
 * (customerPortalOrigin), the customer is sent there instead; partners without a portal keep the
 * legacy page. The portal re-checks the session and ownership itself.
 *
 * `signedOutTo` (lost-features C2): where a signed-out visitor goes instead of /account/login. The
 * receipt and ticket pages pass their /account/continue route, so an expired legacy cookie (which the
 * proxy lets through) still reaches the right partner's portal sign-in.
 */
export async function requireCustomer(
  opts: { portalPath?: `/portal${string}`; signedOutTo?: `/account/continue/${string}` } = {},
): Promise<Customer> {
  const customer = await getCurrentCustomer();
  if (!customer) redirect(opts.signedOutTo ?? '/account/login');
  if (opts.portalPath) {
    const origin = await customerPortalOrigin(customer.partnerId);
    if (origin) redirect(portalUrl(origin, opts.portalPath));
  }
  return customer;
}
