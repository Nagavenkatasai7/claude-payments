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
  const store = getCustomerAuthStore();
  const phone = await store.getSession(token);
  if (!phone) return null;
  const customer = await store.getCustomer(phone);
  if (!customer) return null;
  return customer;
}

export async function requireCustomer(): Promise<Customer> {
  const customer = await getCurrentCustomer();
  if (!customer) redirect('/account/login');
  return customer;
}
