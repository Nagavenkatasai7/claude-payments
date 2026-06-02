import type { CustomerStore } from '../customer-store';
import type { KycProvider, KycStartResult, KycStatus, KycWebhookResult } from './kyc-provider';

/**
 * MockKycProvider: B1 stand-in. startVerification returns the dashboard URL
 * for the customer detail page (staff manually flips kycStatus there).
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
  }): Promise<KycStartResult> {
    return {
      url: `${this.appBaseUrl}/admin-dashboard/customers/${input.senderPhone}`,
      providerRef: `mock-${input.senderPhone}`,
    };
  }

  async getStatus(providerRef: string): Promise<KycStatus> {
    // Extract phone from providerRef "mock-<phone>"
    const phone = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    if (!phone) return 'pending';
    const customer = await this.customerStore.getCustomer(phone);
    if (!customer) return 'pending';
    if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'verified';
    if (customer.kycStatus === 'rejected') return 'rejected';
    return 'pending';
  }

  async handleWebhook(_body: unknown): Promise<KycWebhookResult | null> {
    return null;
  }
}
