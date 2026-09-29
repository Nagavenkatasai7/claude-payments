import { env } from './env';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { getKycCaseStore } from './kyc-case-store';
import { sendGateActive } from './kyc-gate';
import { getPartnerStore } from './partner-store';
import { getKycProvider } from './providers/kyc-provider';
import type { Customer } from './types';

export type StartVerificationResult = { kind: 'gate_off' } | { kind: 'redirect'; url: string };

/**
 * Start identity verification for one customer row (UI redesign M2-11, Task 11.2): the core the legacy
 * /account/verify action and the customer portal share, extracted verbatim from
 * src/app/account/verify/actions.ts (Phase 2, Task 12).
 *
 * KYC is partner OPT-IN, and server actions are public POST endpoints, so the partner ROW is read and
 * the gate checked BEFORE the provider is touched (startVerification creates a REAL Persona inquiry).
 * Gate off → { kind: 'gate_off' }: nothing is created or recorded. Gate on → the provider start
 * (reference-id = the phone, the spine the webhook ties back on), `inquiry_started` + the inquiry id
 * recorded through the kyc-case store (audit action `kyc.start`, actor = `opts.actor`), and the hosted
 * flow URL. Raw PII is captured on the provider's domain, never here.
 *
 * Not decided here (callers own it): a 'delegated' partner (the portal refuses before calling; the
 * legacy action keeps its behaviour). Sanctions screening is untouched: it has no toggle anywhere.
 * The provider's return URL is fixed in the provider template (the Persona provider takes none).
 */
export async function startCustomerVerification(
  customer: Pick<Customer, 'partnerId' | 'senderPhone'>,
  opts: { actor: string },
): Promise<StartVerificationResult> {
  const partner = (await getPartnerStore().getPartner(customer.partnerId)) ?? (await getPartnerStore().ensureDefaultPartner());
  if (!sendGateActive(partner)) return { kind: 'gate_off' };

  const customers = getCustomerStore(getStore());
  const provider = getKycProvider(customers, env.appBaseUrl);

  const { url, providerRef } = await provider.startVerification({
    customerId: customer.senderPhone,
    senderPhone: customer.senderPhone,
  });

  await getKycCaseStore(getStore()).applyDelta(
    customer.partnerId,
    customer.senderPhone,
    {
      kycInquiryId: providerRef,
      kycProviderRef: providerRef,
      kycReviewState: 'inquiry_started',
      kycSubmittedAt: new Date().toISOString(),
    },
    { actor: opts.actor, action: 'kyc.start' },
  );

  return { kind: 'redirect', url };
}
