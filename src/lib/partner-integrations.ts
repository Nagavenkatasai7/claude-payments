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

/**
 * Program-Fix 7 — SENDER funds-capture config: the LICENSED PARTNER's own PSP
 * account (Stripe). Deliberately NOT part of PartnerIntegrations: it has its
 * own encrypted columns (funding_provider_type / funding_credentials_enc) and
 * its own repo methods (getFundingConfig / setFundingConfig), so a dashboard
 * save of the rail/KYC/WhatsApp config can never null it. absent ⇒ the mock
 * (today's behaviour). Only honoured while STRIPE_FUNDING_ENABLED is 'true'.
 */
export interface PartnerFundingConfig {
  providerType?: 'stripe';
  secretKey?: string;          // SECRET — the partner's Stripe secret/restricted key
  webhookSecrets?: string[];   // SECRET — the partner's endpoint signing secret(s) (≤2 while rolling)
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

// ── Program-Fix 29: rail secret rotation (no migration) ──────────────────────
// The CURRENT webhook secret has its own encrypted column (payment.webhookSecret);
// the current signing secret and BOTH previous secrets live in the encrypted
// credentials blob, each previous with its own ISO expiry, so rotating one
// never resets the other's grace period.

export type RailSecretKind = 'webhook' | 'signing';

/** Grace period a rotated-out secret keeps verifying/signing. */
export const RAIL_SECRET_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const PREVIOUS_SECRET_KEYS: Record<RailSecretKind, { secret: string; until: string }> = {
  webhook: { secret: 'previousWebhookSecret', until: 'previousWebhookSecretUntil' },
  signing: { secret: 'previousSigningSecret', until: 'previousSigningSecretUntil' },
};

/**
 * The active secrets for one rail direction: `[current, previous-if-unexpired]`,
 * current FIRST (it still signs the legacy header). No current secret ⇒ []
 * (a previous alone never signs or verifies).
 */
export function railSecrets(
  payment: PartnerPaymentConfig | undefined,
  kind: RailSecretKind,
  now: Date,
): string[] {
  const creds = payment?.credentials ?? {};
  const current = (kind === 'webhook' ? payment?.webhookSecret : creds.signingSecret) ?? '';
  if (current === '') return [];
  const keys = PREVIOUS_SECRET_KEYS[kind];
  const previous = creds[keys.secret] ?? '';
  const until = Date.parse(creds[keys.until] ?? '');
  if (previous !== '' && previous !== current && Number.isFinite(until) && until > now.getTime()) {
    return [current, previous];
  }
  return [current];
}

/**
 * Record a rotation in the credentials blob (a COPY is returned): when a stored
 * non-empty secret is replaced by a DIFFERENT non-empty one, the old value
 * becomes `previous<Kind>Secret` with its own `…Until` = now + grace. A first
 * mint (no old value) or an unchanged value is not a rotation. Expired
 * previous pairs of either kind are dropped.
 */
export function withRotatedSecret(
  credentials: Record<string, string>,
  kind: RailSecretKind,
  oldSecret: string | undefined,
  newSecret: string | undefined,
  now: Date,
): Record<string, string> {
  const out = pruneExpiredPrevious(credentials, now);
  const keys = PREVIOUS_SECRET_KEYS[kind];
  if (oldSecret && newSecret && oldSecret !== newSecret) {
    out[keys.secret] = oldSecret;
    out[keys.until] = new Date(now.getTime() + RAIL_SECRET_GRACE_MS).toISOString();
  }
  return out;
}

/** A copy with every expired / unparseable previous-secret pair removed. */
export function pruneExpiredPrevious(credentials: Record<string, string>, now: Date): Record<string, string> {
  const out = { ...credentials };
  for (const keys of Object.values(PREVIOUS_SECRET_KEYS)) {
    if (!(keys.secret in out) && !(keys.until in out)) continue;
    const until = Date.parse(out[keys.until] ?? '');
    if (!Number.isFinite(until) || until <= now.getTime() || !out[keys.secret]) {
      delete out[keys.secret];
      delete out[keys.until];
    }
  }
  return out;
}
