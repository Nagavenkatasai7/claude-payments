import type { PersonaClient } from './persona-client';
import { parsePersonaEvent } from './persona-webhook-parse';
import type { KycProvider, KycStartResult, KycStatus, KycWebhookResult } from './kyc-provider';

/**
 * PersonaKycProvider (Phase 2, Task 8) — implements the KycProvider seam against
 * the real Persona hosted flow. `startVerification` creates an inquiry
 * (reference-id = the customer's phone) and returns a one-time hosted-flow link;
 * raw PII is captured on Persona's domain, never here.
 *
 * `getStatus`/`handleWebhook` expose Persona's VERDICT only. The customer's
 * gate-driving `kycStatus` is moved to a terminal value ONLY by a human
 * (`kyc-case-store.review`); the /api/persona-webhook route uses the richer
 * `applyKycEvent` state machine. This mapping is here for seam parity.
 */
function mapInquiryStatus(status: string | null): KycStatus {
  switch (status) {
    case 'approved':
    case 'completed':
      return 'verified';
    case 'declined':
    case 'failed':
      return 'rejected';
    default:
      return 'pending';
  }
}

export class PersonaKycProvider implements KycProvider {
  constructor(
    private readonly client: PersonaClient,
    private readonly appBaseUrl: string,
  ) {}

  async startVerification(input: { customerId: string; senderPhone: string }): Promise<KycStartResult> {
    const { inquiryId } = await this.client.createInquiry({
      referenceId: input.senderPhone,
      idempotencyKey: `kyc-${input.senderPhone}-${Date.now()}`,
    });
    const url = await this.client.generateOneTimeLink(inquiryId);
    return { url, providerRef: inquiryId };
  }

  async getStatus(providerRef: string): Promise<KycStatus> {
    const { status } = await this.client.getInquiry(providerRef);
    return mapInquiryStatus(status);
  }

  async handleWebhook(body: unknown): Promise<KycWebhookResult | null> {
    const ev = parsePersonaEvent(body);
    if (!ev || !ev.inquiryId) return null;
    return {
      providerRef: ev.inquiryId,
      status: mapInquiryStatus(ev.status),
      rejectedReason:
        ev.name === 'inquiry.declined' || ev.name === 'inquiry.failed' ? ev.name : undefined,
    };
  }
}
