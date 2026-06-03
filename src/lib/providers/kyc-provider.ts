import { env } from '../env';
import type { CustomerStore } from '../customer-store';
import { MockKycProvider } from './mock-kyc-provider';
import { PersonaKycProvider } from './persona-kyc-provider';
import { createPersonaClient } from './persona-client';

export type KycStatus = 'pending' | 'verified' | 'rejected';

export interface KycStartResult {
  url: string;
  providerRef: string;
}

export interface KycVerifiedFields {
  fullName?: string;
  dateOfBirth?: string;
  country?: string;
}

export interface KycWebhookResult {
  providerRef: string;
  status: KycStatus;
  fields?: KycVerifiedFields;
  rejectedReason?: string;
}

export interface KycProvider {
  /**
   * Begin (or re-issue) identity verification and return a hosted-flow link.
   * When `existingInquiryId` is supplied, providers MUST reuse that inquiry and
   * only mint a fresh one-time link — never create a new inquiry. This lets a
   * customer who taps "resend the verify link" get a working link without
   * minting a new Persona inquiry on every tap.
   */
  startVerification(input: {
    customerId: string;
    senderPhone: string;
    existingInquiryId?: string;
  }): Promise<KycStartResult>;
  getStatus(providerRef: string): Promise<KycStatus>;
  handleWebhook(body: unknown): Promise<KycWebhookResult | null>;
}

// ── Factory (Phase 2) — mirrors getPaymentProvider/getSanctionsScreener ──
// Selects the real Persona provider once PERSONA_API_KEY is provisioned; until
// then the Mock keeps existing behavior. Single switch point; no call-site change.
// (The mock/persona modules import only TYPES from this file, so there is no
// runtime import cycle despite the static imports above.)
export function getKycProvider(customerStore: CustomerStore, appBaseUrl: string): KycProvider {
  if (env.personaApiKey) {
    const client = createPersonaClient({
      apiKey: env.personaApiKey,
      apiVersion: env.personaApiVersion,
      base: env.personaApiBase,
      templateVersionId: env.personaInquiryTemplateVersionId,
    });
    return new PersonaKycProvider(client, appBaseUrl);
  }
  return new MockKycProvider(customerStore, appBaseUrl);
}
