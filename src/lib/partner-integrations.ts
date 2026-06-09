// partner-integrations — the SECRET-BEARING technical config a white-label
// partner is provisioned with (WL1). This is the at-rest contract for the
// `partner:{id}:integrations` Redis row.
//
// Split of responsibility (do not duplicate):
//   • Branding + kycMode + requireKycBeforeSend live on the *Partner record*
//     (types.ts) — non-secret, read on every turn via the pure resolver, so the
//     hot path never fetches this row.
//   • Provider SELECTION + CREDENTIALS live here — read only by the provider
//     seams (payment / KYC / WhatsApp), never in the per-turn hot path.
//
// Secrets (apiKey/webhookSecret/credentials/token/verifyToken) are envelope-
// encrypted at rest by partner-integrations-store.ts. The non-secret selectors
// (providerType, phoneNumberId) are stored in the clear so a branding-only or
// mock partner never touches the master key.

/** KYC vendor selection + creds for a partner running 'ours' KYC with their own vendor account. */
export interface PartnerKycConfig {
  providerType?: 'ours' | 'persona' | 'partner'; // absent ⇒ fall through to env/global selection
  apiKey?: string; // SECRET
  webhookSecret?: string; // SECRET
}

/** Settlement-rail selection + creds. absent/'mock' ⇒ MockPaymentProvider (default flow). */
export interface PartnerPaymentConfig {
  providerType?: string; // 'mock' | <real rail id, Phase C>; absent ⇒ mock
  credentials?: Record<string, string>; // SECRET (whole sub-blob)
  webhookSecret?: string; // SECRET — fail-closed HMAC for this partner's rail webhook
}

/** BYO WhatsApp (Meta WABA) routing + creds. absent ⇒ the shared SmartRemit number. */
export interface PartnerWhatsappConfig {
  phoneNumberId?: string; // non-secret routing id (Meta sends it on every inbound)
  token?: string; // SECRET — Graph API access token for outbound sends
  verifyToken?: string; // SECRET — webhook GET-verify challenge token
  appSecret?: string; // SECRET — Meta App secret for inbound x-hub-signature-256 verification
}

/** The fully-resolved technical config (all sub-objects always present, possibly empty). */
export interface PartnerIntegrations {
  kyc: PartnerKycConfig;
  payment: PartnerPaymentConfig;
  whatsapp: PartnerWhatsappConfig;
}

/** A partner with no integrations row resolves to this — i.e. today's behavior. */
export const EMPTY_PARTNER_INTEGRATIONS: PartnerIntegrations = {
  kyc: {},
  payment: {},
  whatsapp: {},
};
