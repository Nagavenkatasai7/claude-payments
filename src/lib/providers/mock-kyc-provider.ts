import type { CustomerStore } from '../customer-store';
import type { KycProvider, KycStartResult, KycStatus, KycWebhookResult } from './kyc-provider';

/**
 * MockKycProvider: B1 stand-in. startVerification returns the dashboard URL
 * of the customers list (staff open the customer and flip kycStatus there).
 * B2 will replace this with PersonaKycProvider behind the same interface.
 */
export class MockKycProvider implements KycProvider {
  constructor(
    private readonly customerStore: CustomerStore,
    private readonly appBaseUrl: string,
  ) {}

  async startVerification(input: {
    customerId: string;
    senderPhone: string;
    existingInquiryId?: string;
  }): Promise<KycStartResult> {
    return {
      // Program-Fix 37: the customers LIST, never a phone-keyed URL. This link
      // is sent to the customer, and the detail route is keyed on a sealed ref
      // now. providerRef keeps `mock-<phone>`: it is server-side only, and
      // getStatus below parses it.
      url: `${this.appBaseUrl}/admin-dashboard/customers`,
      providerRef: input.existingInquiryId ?? `mock-${input.senderPhone}`,
    };
  }

  async getStatus(providerRef: string): Promise<KycStatus> {
    // providerRef is "mock-<phone>". A phone may have a row per tenant (fix 1):
    // bind by the ref the row recorded, else the single unambiguous row.
    const phone = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    if (!phone) return 'pending';
    const rows = await this.customerStore.findByPhone(phone);
    const customer = rows.find((c) => c.kycProviderRef === providerRef) ?? (rows.length === 1 ? rows[0] : null);
    if (!customer) return 'pending';
    if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'verified';
    if (customer.kycStatus === 'rejected') return 'rejected';
    return 'pending';
  }

  async handleWebhook(_body: unknown): Promise<KycWebhookResult | null> {
    return null;
  }
}
