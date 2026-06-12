import { chat } from './ollama';
import { getRedis } from './redis';
import { getStore, type RedisLike } from './store';
import { getCustomerStore } from './customer-store';
import { getPartnerStore } from './partner-store';
import { getDailyVolumeStore } from './daily-volume-store';
import { evaluateCap } from './tier-rules';
import { sendGateActive } from './kyc-gate';
import { logWarn } from './log';
import type {
  ChatMessage,
  ChatTool,
  Customer,
  Partner,
  PartnerId,
  RefundStatus,
  Tier,
  Transfer,
} from './types';

/**
 * customer-summary — the AI "smart summary" card on the customer dashboard.
 *
 * One-shot `chat(messages, [])` (NO tools, NO agent loop) over a context built
 * EXCLUSIVELY from the customer's OWN data:
 *   - last 5 transfers (id / recipient / amount / status / refund state) from
 *     the default MASKED ledger read — and even the masked payout destination
 *     is deliberately NOT projected into the context,
 *   - tier + remaining daily limit (the same evaluateCap/sendGateActive
 *     composition check_send_limit uses),
 *   - how many refunds are still in flight.
 *
 * GUARDRAILS (do not regress):
 *   - READ-ONLY: the only write anywhere is the Redis cache entry.
 *   - settlementPartnerId, complianceReasons, payout destinations, and
 *     recipient phone numbers NEVER enter the prompt context.
 *   - Any model failure (throw, timeout, empty reply) returns null — the card
 *     simply doesn't render. Errors go through the PII-scrubbing logger only.
 */

export const SUMMARY_SYSTEM_PROMPT = [
  'You write a short account summary for a SmartRemit customer, shown as a card on their account dashboard.',
  "You are given a JSON snapshot of the customer's OWN account: their most recent transfers (id, recipient, amount, status, refund state), their current tier, their remaining daily sending limit in USD, and how many refunds are still in progress.",
  'Rules:',
  '- Reply with 2-3 friendly sentences in plain language. Plain text only — no lists, no markdown, no emojis.',
  '- NEVER invent numbers, transfers, dates, or facts that are not in the JSON snapshot. Amounts in the snapshot are exact — repeat them verbatim or leave them out.',
  '- NO financial advice of any kind: never suggest when or how much to send, never comment on exchange-rate timing, never mention investments.',
  '- NO promises or guarantees: never promise delivery times or outcomes.',
  '- NO compliance detail: never mention screening, sanctions, reviews, or verification internals. If a transfer is held up, say the team is taking a look.',
].join('\n');

/** Customer-friendly status words so the model never parrots raw enum values. */
const STATUS_FACT: Record<string, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'processing',
  delivered: 'delivered',
  cancelled: 'cancelled',
  in_review: 'being looked at by the team',
  blocked: 'could not be completed',
};

export interface SummaryTransferFact {
  id: string;
  recipient: string;
  amount: number;
  currency: string;
  status: string;
  refund: RefundStatus;
}

export interface SummaryContext {
  tier: Tier;
  dailyLimitUsd: number;
  dailyRemainingUsd: number;
  pendingRefunds: number;
  recentTransfers: SummaryTransferFact[];
}

/**
 * Project the customer's own data into the prompt context. PURE — and the ONLY
 * place that decides what the model may see. Each transfer contributes exactly
 * five facts; nothing else on the Transfer row (settlementPartnerId,
 * complianceReasons, payoutDestination, recipientPhone, …) is reachable.
 */
export function buildSummaryContext(
  customer: Customer,
  transfers: Transfer[],
  todayUsedCents: number,
  kycGateActive: boolean,
  now: Date = new Date(),
): SummaryContext {
  const cap = evaluateCap(customer, now, todayUsedCents, 0, kycGateActive);
  return {
    tier: cap.tier,
    dailyLimitUsd: cap.dailyCapCents / 100,
    dailyRemainingUsd: cap.todayRemainingCents / 100,
    pendingRefunds: transfers.filter(
      (t) => t.refundStatus === 'requested' || t.refundStatus === 'pending',
    ).length,
    recentTransfers: transfers.slice(0, 5).map((t) => ({
      id: t.id,
      recipient: t.recipientName,
      amount: t.amountSource ?? t.amountUsd,
      currency: t.sourceCurrency ?? 'USD',
      status: STATUS_FACT[t.status] ?? t.status,
      refund: t.refundStatus ?? 'none',
    })),
  };
}

const SUMMARY_TTL_SECONDS = 24 * 60 * 60; // 24h — the card is a digest, not live data
const DEFAULT_TIMEOUT_MS = 12_000;

const cacheKey = (phone: string) => `summary:${phone}`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`customer-summary: model timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface CustomerSummarizerDeps {
  redis: RedisLike;
  store: { listTransfersByPhone(phone: string, limit?: number): Promise<Transfer[]> };
  customers: { getCustomer(phone: string): Promise<Customer | null> };
  partners: {
    getPartner(id: PartnerId): Promise<Partner | null>;
    ensureDefaultPartner(): Promise<Partner>;
  };
  dailyVolume: { getTodayCents(phone: string): Promise<number> };
  /** Injectable model seam (defaults to the shared Ollama client). */
  chatFn?: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  timeoutMs?: number;
}

export function createCustomerSummarizer(deps: CustomerSummarizerDeps) {
  const chatFn = deps.chatFn ?? chat;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    /**
     * The customer's smart summary, from cache when fresh (`summary:<phone>`,
     * 24h TTL, plain string — `automaticDeserialization:false` everywhere).
     * Returns null on ANY failure so the dashboard card simply doesn't render.
     */
    async getCustomerSummary(phone: string): Promise<string | null> {
      try {
        const cached = await deps.redis.get(cacheKey(phone));
        if (cached) return cached;

        const [customer, transfers, todayUsedCents] = await Promise.all([
          deps.customers.getCustomer(phone),
          deps.store.listTransfersByPhone(phone, 5),
          deps.dailyVolume.getTodayCents(phone),
        ]);
        if (!customer) return null;
        const partner =
          (await deps.partners.getPartner(customer.partnerId)) ??
          (await deps.partners.ensureDefaultPartner());
        const context = buildSummaryContext(
          customer,
          transfers,
          todayUsedCents,
          sendGateActive(partner),
        );

        const reply = await withTimeout(
          chatFn(
            [
              { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(context) },
            ],
            [], // one-shot: NO tools, NO agent loop
          ),
          timeoutMs,
        );
        const text = typeof reply.content === 'string' ? reply.content.trim() : '';
        if (!text) return null;

        await deps.redis.set(cacheKey(phone), text, { ex: SUMMARY_TTL_SECONDS });
        return text;
      } catch (err) {
        // Scrubbed log only — never the raw error (provider bodies can echo PII).
        logWarn('customer-summary', err);
        return null;
      }
    },
  };
}

export type CustomerSummarizer = ReturnType<typeof createCustomerSummarizer>;

let cached: CustomerSummarizer | null = null;

function summarizer(): CustomerSummarizer {
  if (!cached) {
    cached = createCustomerSummarizer({
      redis: getRedis(),
      store: getStore(),
      customers: getCustomerStore(getStore()),
      partners: getPartnerStore(),
      dailyVolume: getDailyVolumeStore(),
    });
  }
  return cached;
}

/** Dashboard entry point: the customer's AI summary, or null (card hidden). */
export function getCustomerSummary(phone: string): Promise<string | null> {
  return summarizer().getCustomerSummary(phone);
}
