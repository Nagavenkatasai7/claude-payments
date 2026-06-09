import { eq } from 'drizzle-orm';
import { partnerIntegrations } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { openOptional, sealOptional } from './mappers';
import {
  EMPTY_PARTNER_INTEGRATIONS,
  type PartnerIntegrations,
} from '@/lib/partner-integrations';
import type { PartnerId } from '@/lib/types';

// integrations-repo — mirrors partner-integrations-store (getIntegrations /
// saveIntegrations / deleteIntegrations). Secrets are envelope-encrypted into
// the *_enc columns INSIDE this repo; callers only ever see plaintext config or
// the fully-defaulted EMPTY (no row ⇒ today's behavior: mock rail, env KYC,
// shared WhatsApp number). Non-secret selectors (providerType, phoneNumberId)
// are plain columns so a branding-only partner never touches the master key.

export function createIntegrationsRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    async getIntegrations(id: PartnerId): Promise<PartnerIntegrations> {
      const rows = await db
        .select()
        .from(partnerIntegrations)
        .where(eq(partnerIntegrations.partnerId, id))
        .limit(1);
      const row = rows[0];
      if (!row) return EMPTY_PARTNER_INTEGRATIONS;
      const credsJson = openOptional(row.paymentCredentialsEnc, provider);
      const compact = <T extends Record<string, unknown>>(o: T): T =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
      return {
        kyc: compact({
          providerType: row.kycProviderType as PartnerIntegrations['kyc']['providerType'],
          apiKey: openOptional(row.kycApiKeyEnc, provider),
          webhookSecret: openOptional(row.kycWebhookSecretEnc, provider),
        }),
        payment: compact({
          providerType: row.paymentProviderType ?? undefined,
          credentials: credsJson ? (JSON.parse(credsJson) as Record<string, string>) : undefined,
          webhookSecret: openOptional(row.paymentWebhookSecretEnc, provider),
        }),
        whatsapp: compact({
          phoneNumberId: row.waPhoneNumberId ?? undefined,
          token: openOptional(row.waTokenEnc, provider),
          verifyToken: openOptional(row.waVerifyTokenEnc, provider),
          appSecret: openOptional(row.waAppSecretEnc, provider),
        }),
      };
    },

    async saveIntegrations(id: PartnerId, config: PartnerIntegrations): Promise<void> {
      const row = {
        partnerId: id,
        kycProviderType: config.kyc?.providerType ?? null,
        kycApiKeyEnc: sealOptional(config.kyc?.apiKey, provider) ?? null,
        kycWebhookSecretEnc: sealOptional(config.kyc?.webhookSecret, provider) ?? null,
        paymentProviderType: config.payment?.providerType ?? null,
        paymentCredentialsEnc: config.payment?.credentials
          ? sealOptional(JSON.stringify(config.payment.credentials), provider)!
          : null,
        paymentWebhookSecretEnc: sealOptional(config.payment?.webhookSecret, provider) ?? null,
        waPhoneNumberId: config.whatsapp?.phoneNumberId ?? null,
        waTokenEnc: sealOptional(config.whatsapp?.token, provider) ?? null,
        waVerifyTokenEnc: sealOptional(config.whatsapp?.verifyToken, provider) ?? null,
        waAppSecretEnc: sealOptional(config.whatsapp?.appSecret, provider) ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(partnerIntegrations)
        .values(row)
        .onConflictDoUpdate({ target: partnerIntegrations.partnerId, set: row });
    },

    /** Crypto-shred: dropping the row destroys the only copy of the wrapped DEKs. */
    async deleteIntegrations(id: PartnerId): Promise<void> {
      await db.delete(partnerIntegrations).where(eq(partnerIntegrations.partnerId, id));
    },

    /** Reverse lookup for inbound WhatsApp routing: phone_number_id → partner. */
    async partnerForPhoneNumberId(phoneNumberId: string): Promise<PartnerId | null> {
      if (!phoneNumberId) return null;
      const rows = await db
        .select({ partnerId: partnerIntegrations.partnerId })
        .from(partnerIntegrations)
        .where(eq(partnerIntegrations.waPhoneNumberId, phoneNumberId))
        .limit(1);
      return rows[0]?.partnerId ?? null;
    },
  };
}

export type IntegrationsRepo = ReturnType<typeof createIntegrationsRepo>;
