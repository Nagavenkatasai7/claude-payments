import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { PartnerId } from './types';

// partner-whatsapp-index — reverse map from a Meta phone_number_id to the owning
// partner, so the inbound webhook can route a message to the right white-label
// partner. Written when a partner saves their WhatsApp config (old id cleared,
// new id set); read on every inbound POST. A phone_number_id is non-secret
// routing data, so it's stored in the clear.

const key = (phoneNumberId: string) => `whatsapp:pnid:${phoneNumberId}`;

export function createPartnerWhatsappIndex(redis: RedisLike) {
  return {
    async setPnid(phoneNumberId: string, partnerId: PartnerId): Promise<void> {
      if (!phoneNumberId) return;
      await redis.set(key(phoneNumberId), partnerId);
    },
    async clearPnid(phoneNumberId: string): Promise<void> {
      if (!phoneNumberId) return;
      await redis.del(key(phoneNumberId));
    },
    /** The partner that owns this phone_number_id, or null (⇒ default partner). */
    async partnerForPnid(phoneNumberId: string): Promise<PartnerId | null> {
      if (!phoneNumberId) return null;
      const v = await redis.get(key(phoneNumberId));
      return v ? (v as PartnerId) : null;
    },
  };
}

export type PartnerWhatsappIndex = ReturnType<typeof createPartnerWhatsappIndex>;

let cached: PartnerWhatsappIndex | null = null;

export function getPartnerWhatsappIndex(): PartnerWhatsappIndex {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPartnerWhatsappIndex(redis as unknown as RedisLike);
  }
  return cached;
}
