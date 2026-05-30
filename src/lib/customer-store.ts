import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike, Store } from './store';
import type { Customer, FundingMethod } from './types';
import { DEFAULT_SENDER_COUNTRY, DEFAULT_PARTNER_ID } from './defaults';

export function createCustomerStore(redis: RedisLike, store: Store) {
  return {
    async getCustomer(senderPhone: string): Promise<Customer | null> {
      const raw = await redis.get(`customer:${senderPhone}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Customer;
        // Lazy fill for pre-P1/P2 records missing required fields (in-memory only;
        // the cron pass is the only writer for backfilled records)
        if (!parsed.senderCountry) {
          parsed.senderCountry = DEFAULT_SENDER_COUNTRY;
        }
        if (!parsed.partnerId) {
          parsed.partnerId = DEFAULT_PARTNER_ID;
        }
        return parsed;
      } catch {
        return null;
      }
    },

    async saveCustomer(customer: Customer): Promise<void> {
      await redis.set(`customer:${customer.senderPhone}`, JSON.stringify(customer));
      await redis.sadd('customers:phones', customer.senderPhone);
    },

    async upsertOnFirstInbound(
      senderPhone: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(senderPhone);
      if (existing) return { customer: existing, wasCreated: false };

      // Lazy grandfather: peek at existing transfers
      const transfers = await store.listTransfers();
      const minAt = transfers
        .filter((t) => t.phone === senderPhone)
        .map((t) => t.createdAt)
        .sort()[0];

      const nowIso = new Date().toISOString();
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            senderCountry: DEFAULT_SENDER_COUNTRY,  // NEW (P1)
            partnerId: DEFAULT_PARTNER_ID,          // NEW (P2)
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            senderCountry: DEFAULT_SENDER_COUNTRY,  // NEW (P1)
            partnerId: DEFAULT_PARTNER_ID,          // NEW (P2)
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    async recordFundingMethod(senderPhone: string, method: FundingMethod): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return; // nothing to stick to yet (no-op for brand-new senders)
      const nowIso = new Date().toISOString();
      await this.saveCustomer({
        ...customer,
        lastFundingMethod: method,
        lastFundingMethodAt: nowIso,
        updatedAt: nowIso,
      });
    },

    async listCustomers(): Promise<Customer[]> {
      const phones = await redis.smembers('customers:phones');
      const all = await Promise.all(phones.map((p) => this.getCustomer(p)));
      return all.filter((c): c is Customer => c !== null);
    },
  };
}

export type CustomerStore = ReturnType<typeof createCustomerStore>;

let cached: CustomerStore | null = null;

export function getCustomerStore(store: Store): CustomerStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createCustomerStore(redis as unknown as RedisLike, store);
  }
  return cached;
}
