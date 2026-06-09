import { env } from '../env';
import type { CustomerStore } from '../customer-store';
import type { PartnerKycConfig } from '../partner-integrations';
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
// Selection order (WL1, per-partner): a partner's OWN Persona credentials first,
// then the global env Persona key, then the Mock. The optional `kyc` arg is
// additive — omit it (or pass a partner with no Persona creds) and the behavior
// is byte-for-byte today (env-driven). Single switch point; no call-site change
// for the default partner.
// (The mock/persona modules import only TYPES from this file, so there is no
// runtime import cycle despite the static imports above.)
export function getKycProvider(
  customerStore: CustomerStore,
  appBaseUrl: string,
  kyc?: PartnerKycConfig,
): KycProvider {
  // Per-partner Persona account (the partner brings their own KYC vendor creds).
  if (kyc?.providerType === 'persona' && kyc.apiKey) {
    const client = createPersonaClient({
      apiKey: kyc.apiKey,
      apiVersion: env.personaApiVersion,
      base: env.personaApiBase,
      templateVersionId: env.personaInquiryTemplateVersionId,
    });
    return new PersonaKycProvider(client, appBaseUrl);
  }
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
