'use server';

import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { getKycProvider } from '@/lib/providers/kyc-provider';

/**
 * Start identity verification for the logged-in customer (Phase 2, Task 12).
 * Gated by requireCustomer AND the partner's OPT-IN KYC gate (sendGateActive)
 * — gate off ⇒ redirect to /account without touching the provider. When the
 * gate is on, creates a real Persona inquiry (reference-id = the customer's
 * phone — the spine that ties the webhook back to this account), records
 * `inquiry_started` + the inquiry id (audit-logged), then redirects to the
 * Persona hosted flow where raw PII is captured (never on our servers).
 */
export async function startVerificationAction(): Promise<void> {
  const customer = await requireCustomer();

  // KYC is partner OPT-IN — and server actions are public POST endpoints, so
  // hiding the verify page is not a gate. Read the customer's partner ROW and
  // refuse BEFORE touching the provider (startVerification creates a REAL
  // Persona inquiry). Gate off ⇒ bounce home; nothing is created or recorded.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (!sendGateActive(partner)) redirect('/account');

  const customers = getCustomerStore(getStore());
  const provider = getKycProvider(customers, env.appBaseUrl);

  const { url, providerRef } = await provider.startVerification({
    customerId: customer.senderPhone,
    senderPhone: customer.senderPhone,
  });

  await getKycCaseStore(getStore()).applyDelta(
    customer.senderPhone,
    {
      kycInquiryId: providerRef,
      kycProviderRef: providerRef,
      kycReviewState: 'inquiry_started',
      kycSubmittedAt: new Date().toISOString(),
    },
    { actor: customer.senderPhone, action: 'kyc.start' },
  );

  redirect(url); // off to the Persona hosted flow
}
