import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Customer } from './types';
import { getCustomerAuthStore } from './customer-auth-store';
import { CUSTOMER_SESSION_COOKIE } from './customer-session-cookie';

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

export async function requireCustomer(): Promise<Customer> {
  const customer = await getCurrentCustomer();
  if (!customer) redirect('/account/login');
  return customer;
}
