'use server';

import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { startCustomerVerification } from '@/lib/customer-verification';
import { refuseOnSiteHost } from '@/lib/site-host-guard';

/**
 * Start identity verification for the logged-in customer (Phase 2, Task 12).
 * Gated by requireCustomer AND the partner's OPT-IN KYC gate (sendGateActive)
 * — gate off ⇒ redirect to /account without touching the provider. When the
 * gate is on, creates a real Persona inquiry (reference-id = the customer's
 * phone — the spine that ties the webhook back to this account), records
 * `inquiry_started` + the inquiry id (audit-logged), then redirects to the
 * Persona hosted flow where raw PII is captured (never on our servers).
 * The steps live in startCustomerVerification (shared with the customer
 * portal, UI redesign M2-11); this action's behaviour is unchanged.
 */
export async function startVerificationAction(): Promise<void> {
  await refuseOnSiteHost();
  const customer = await requireCustomer();
  const res = await startCustomerVerification(customer, { actor: customer.senderPhone });
  if (res.kind === 'gate_off') redirect('/account');
  redirect(res.url); // off to the Persona hosted flow
}
