import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import {
  encryptField,
  decryptField,
  defaultProvider,
  type EncryptionKeyProvider,
} from './field-crypto';
import {
  EMPTY_PARTNER_INTEGRATIONS,
  type PartnerIntegrations,
} from './partner-integrations';

// partner-integrations-store — persists `partner:{id}:integrations`, the
// secret-bearing technical config for a white-label partner.
//
// SECURITY: every secret field (kyc.apiKey/webhookSecret, payment.credentials/
// webhookSecret, whatsapp.token/verifyToken) is envelope-encrypted via
// field-crypto BEFORE it reaches Redis, so a leaked Redis token yields only
// ciphertext. Non-secret SELECTORS (providerType, phoneNumberId) are stored in
// the clear so a mock/branding-only partner never touches the master key.
// Encryption/decryption happens INSIDE these functions — callers only ever see
// plaintext config or a fully-defaulted empty config; they never handle blobs.

const key = (id: PartnerId) => `partner:${id}:integrations`;

// At-rest shape: secret strings replaced by their encrypted blob (…Enc fields);
// `payment.credentials` is JSON-stringified then sealed as one blob.
interface StoredIntegrations {
  kyc: { providerType?: string; apiKeyEnc?: string; webhookSecretEnc?: string };
  payment: {
    providerType?: string;
    credentialsEnc?: string;
    webhookSecretEnc?: string;
  };
  whatsapp: {
    phoneNumberId?: string;
    tokenEnc?: string;
    verifyTokenEnc?: string;
  };
}

function seal(
  value: string | undefined,
  provider: EncryptionKeyProvider,
): string | undefined {
  if (value === undefined) return undefined;
  return encryptField(value, provider);
}

function open(
  blob: string | undefined,
  provider: EncryptionKeyProvider,
): string | undefined {
  // Decrypt failures (tamper / key mismatch) MUST throw loudly — silently
  // dropping a misconfigured secret could fall a partner back to mock/global
  // without anyone noticing. JSON corruption is handled separately (→ null).
  if (blob === undefined) return undefined;
  return decryptField(blob, provider);
}

// Drop undefined keys so the at-rest JSON stays minimal and a branding-only
// partner serializes to `{"kyc":{},"payment":{},"whatsapp":{}}`.
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

export function createPartnerIntegrationsStore(
  redis: RedisLike,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    /** Returns the fully-defaulted plaintext config; null integrations ⇒ today's behavior. */
    async getIntegrations(id: PartnerId): Promise<PartnerIntegrations> {
      const raw = await redis.get(key(id));
      if (!raw) return EMPTY_PARTNER_INTEGRATIONS;
      let stored: StoredIntegrations;
      try {
        stored = JSON.parse(raw) as StoredIntegrations;
      } catch {
        // Corrupt row ⇒ behave as unconfigured (fail safe to the default flow).
        return EMPTY_PARTNER_INTEGRATIONS;
      }
      const credsJson = open(stored.payment?.credentialsEnc, provider);
      return {
        kyc: compact({
          providerType: stored.kyc?.providerType,
          apiKey: open(stored.kyc?.apiKeyEnc, provider),
          webhookSecret: open(stored.kyc?.webhookSecretEnc, provider),
        }) as PartnerIntegrations['kyc'],
        payment: compact({
          providerType: stored.payment?.providerType,
          credentials: credsJson
            ? (JSON.parse(credsJson) as Record<string, string>)
            : undefined,
          webhookSecret: open(stored.payment?.webhookSecretEnc, provider),
        }) as PartnerIntegrations['payment'],
        whatsapp: compact({
          phoneNumberId: stored.whatsapp?.phoneNumberId,
          token: open(stored.whatsapp?.tokenEnc, provider),
          verifyToken: open(stored.whatsapp?.verifyTokenEnc, provider),
        }) as PartnerIntegrations['whatsapp'],
      };
    },

    async saveIntegrations(
      id: PartnerId,
      config: PartnerIntegrations,
    ): Promise<void> {
      const stored: StoredIntegrations = {
        kyc: compact({
          providerType: config.kyc?.providerType,
          apiKeyEnc: seal(config.kyc?.apiKey, provider),
          webhookSecretEnc: seal(config.kyc?.webhookSecret, provider),
        }),
        payment: compact({
          providerType: config.payment?.providerType,
          credentialsEnc: config.payment?.credentials
            ? seal(JSON.stringify(config.payment.credentials), provider)
            : undefined,
          webhookSecretEnc: seal(config.payment?.webhookSecret, provider),
        }),
        whatsapp: compact({
          phoneNumberId: config.whatsapp?.phoneNumberId,
          tokenEnc: seal(config.whatsapp?.token, provider),
          verifyTokenEnc: seal(config.whatsapp?.verifyToken, provider),
        }),
      };
      await redis.set(key(id), JSON.stringify(stored));
    },

    /** Crypto-shred: deleting the row destroys the only copy of every wrapped DEK. */
    async deleteIntegrations(id: PartnerId): Promise<void> {
      await redis.del(key(id));
    },
  };
}

export type PartnerIntegrationsStore = ReturnType<
  typeof createPartnerIntegrationsStore
>;

let cached: PartnerIntegrationsStore | null = null;

export function getPartnerIntegrationsStore(): PartnerIntegrationsStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPartnerIntegrationsStore(redis as unknown as RedisLike);
  }
  return cached;
}
