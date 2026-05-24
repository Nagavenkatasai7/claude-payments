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
  startVerification(input: { customerId: string; senderPhone: string }): Promise<KycStartResult>;
  getStatus(providerRef: string): Promise<KycStatus>;
  handleWebhook(body: unknown): Promise<KycWebhookResult | null>;
}
