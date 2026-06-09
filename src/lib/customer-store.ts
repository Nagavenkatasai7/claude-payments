import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike, Store } from './store';
import type { Customer, FundingMethod } from './types';
import { DEFAULT_SENDER_COUNTRY, DEFAULT_PARTNER_ID } from './defaults';
import { countryForPhone } from './partner-currency';

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
      routedPartnerId?: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(senderPhone);
      if (existing) {
        // Fix 5: a returning customer whose record predates optInAt would slip
        // through this fast path and never get consent recorded. Backfill-and-
        // PERSIST it here (first-contact-wins, idempotent) so optInAt is reliably
        // set at the store layer — not dependent on the route remembering to call
        // setOptedIn. This is the path the vast majority of prod inbounds take.
        //
        // WL2 follow-the-number: the PARTNER owns the WhatsApp channel. When the
        // number this customer messaged is mapped to a partner (routedPartnerId)
        // and the record points elsewhere, the customer moves to the channel's
        // partner. Past transfers keep their original partnerId (history is never
        // rewritten); only the customer's go-forward tenant changes.
        const needsOptIn = !existing.optInAt;
        const needsRoute = Boolean(routedPartnerId) && existing.partnerId !== routedPartnerId;
        if (needsOptIn || needsRoute) {
          const nowIso = new Date().toISOString();
          const updated: Customer = {
            ...existing,
            ...(needsOptIn ? { optInAt: nowIso } : {}),
            ...(needsRoute ? { partnerId: routedPartnerId! } : {}),
            updatedAt: nowIso,
          };
          await this.saveCustomer(updated);
          return { customer: updated, wasCreated: false };
        }
        return { customer: existing, wasCreated: false };
      }

      const inferredCountry = countryForPhone(senderPhone) ?? DEFAULT_SENDER_COUNTRY;

      // Lazy grandfather: peek at existing transfers
      const transfers = await store.listTransfers();
      const minAt = transfers
        .filter((t) => t.phone === senderPhone)
        .map((t) => t.createdAt)
        .sort()[0];

      const nowIso = new Date().toISOString();
      // WL2: a customer created via a partner-owned number belongs to that partner.
      const partnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            senderCountry: inferredCountry,          // NEW (P1)
            partnerId,                               // NEW (P2) + WL2 routed
            optInAt: nowIso,                        // NEW (Item 4) — first inbound = opt-in
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            senderCountry: inferredCountry,          // NEW (P1)
            partnerId,                               // NEW (P2) + WL2 routed
            optInAt: nowIso,                        // NEW (Item 4) — first inbound = opt-in
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    // ── WhatsApp consent (Item 4) — all read-modify-write; no-op when no record ──

    // Idempotent transactional opt-in: first contact wins. Used by the route to
    // backfill optInAt for existing/grandfathered records that predate the field.
    async setOptedIn(senderPhone: string): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return;
      if (customer.optInAt) return; // first contact already recorded — no churn
      const nowIso = new Date().toISOString();
      await this.saveCustomer({ ...customer, optInAt: nowIso, updatedAt: nowIso });
    },

    async setOptedOut(senderPhone: string): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return;
      const nowIso = new Date().toISOString();
      await this.saveCustomer({ ...customer, optedOutAt: nowIso, updatedAt: nowIso });
    },

    async clearOptedOut(senderPhone: string): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return;
      const nowIso = new Date().toISOString();
      // Omit optedOutAt entirely so the field disappears from the stored JSON.
      const { optedOutAt: _drop, ...rest } = customer;
      void _drop;
      await this.saveCustomer({ ...rest, updatedAt: nowIso });
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

    // Record a bot-minted Persona inquiry id so a later "resend the verify link"
    // can REUSE it instead of minting a new inquiry. Deliberately does NOT touch
    // kycStatus or kycReviewState — the webhook/human-review state machine owns
    // those (the human-review-only invariant). No-op for unknown customers and
    // idempotent when the id is unchanged (avoids write churn on every resend).
    async recordKycInquiry(senderPhone: string, inquiryId: string): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return;
      if (customer.kycInquiryId === inquiryId) return;
      const nowIso = new Date().toISOString();
      await this.saveCustomer({
        ...customer,
        kycInquiryId: inquiryId,
        kycProviderRef: inquiryId,
        kycSubmittedAt: customer.kycSubmittedAt ?? nowIso,
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
