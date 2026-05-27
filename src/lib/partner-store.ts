import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { Partner, PartnerId } from './types';

export function createPartnerStore(redis: RedisLike) {
  return {
    async getPartner(id: PartnerId): Promise<Partner | null> {
      const raw = await redis.get(`partner:${id}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Partner;
      } catch {
        return null;
      }
    },

    async savePartner(partner: Partner): Promise<void> {
      await redis.set(`partner:${partner.id}`, JSON.stringify(partner));
      await redis.sadd('partners:ids', partner.id);
    },

    async listPartners(): Promise<Partner[]> {
      const ids = await redis.smembers('partners:ids');
      const all = await Promise.all(ids.map((id) => this.getPartner(id)));
      return all.filter((p): p is Partner => p !== null);
    },

    async ensureDefaultPartner(): Promise<Partner> {
      const existing = await this.getPartner('default');
      if (existing) return existing;
      const now = new Date().toISOString();
      const fresh: Partner = {
        id: 'default',
        name: 'SendHome Default',
        countries: ['US'],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      await this.savePartner(fresh);
      return fresh;
    },
  };
}

export type PartnerStore = ReturnType<typeof createPartnerStore>;

let cached: PartnerStore | null = null;

export function getPartnerStore(): PartnerStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPartnerStore(redis as unknown as RedisLike);
  }
  return cached;
}
