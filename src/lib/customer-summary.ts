import { chat } from './llm';
import { getRedis } from './redis';
import { getStore, type RedisLike } from './store';
import { getCustomerStore } from './customer-store';
import { getPartnerStore } from './partner-store';
import { getDailyVolumeStore } from './daily-volume-store';
import { evaluateCap } from './tier-rules';
import { PLATFORM_SEND_LIMITS, resolveEffectiveSendLimits } from './send-limits';
import type { SendLimits } from './types';
import { sendGateActive } from './kyc-gate';
import { logWarn } from './log';
import { FIXED_REPLIES } from './hold-replies';
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
 *   - tier + daily limit (the same evaluateCap/sendGateActive composition
 *     check_send_limit uses); R30: never the day's headroom,
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
  "You are given a JSON snapshot of the customer's OWN account: their most recent transfers (id, recipient, amount, status, refund state), their current tier, their daily sending limit in USD, and how many refunds are still in progress.",
  'Rules:',
  '- Reply with 2-3 friendly sentences in plain language. Plain text only — no lists, no markdown, no emojis.',
  '- NEVER invent numbers, transfers, dates, or facts that are not in the JSON snapshot. Amounts in the snapshot are exact — repeat them verbatim or leave them out.',
  '- NO financial advice of any kind: never suggest when or how much to send, never comment on exchange-rate timing, never mention investments.',
  '- NO promises or guarantees: never promise delivery times or outcomes.',
  `- NO compliance detail: never mention screening, sanctions, reviews, or verification internals. A transfer whose status is "${FIXED_REPLIES.status_held}" is being processed: say only that, never why.`,
  '- Never say how much the customer has left to send today.',
].join('\n');

/** Customer-friendly status words so the model never parrots raw enum values. */
const STATUS_FACT: Record<string, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'processing',
  delivered: 'delivered',
  cancelled: 'cancelled',
  in_review: FIXED_REPLIES.status_held, // R30: the fixed hold label, never a reason
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
  // Program fix 16/16b: the sender's EFFECTIVE limits (resolveEffectiveSendLimits(partner, customer));
  // the platform ladder by default so a partner-less caller states the truth.
  limits: SendLimits = PLATFORM_SEND_LIMITS,
  now: Date = new Date(),
): SummaryContext {
  const cap = evaluateCap(customer, now, todayUsedCents, 0, kycGateActive, limits);
  return {
    tier: cap.tier,
    dailyLimitUsd: cap.dailyCapCents / 100,
    // R30 (no tipping-off): never the remaining figure, on any surface.
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

/**
 * Deterministic fallback digest — a plain-text summary built PURELY from the
 * same SummaryContext the model would have received, with NO model call and NO
 * cache. The dashboard renders this whenever getCustomerSummary returns null (a
 * model/cache failure) so the summary card is never silently empty.
 *
 * Same guardrails as the AI path by construction: it only reads SummaryContext,
 * which already excludes payout destinations, recipient phones, compliance
 * reasons, and settlementPartnerId. No advice, no promises — just the
 * customer's own facts restated. Always returns non-empty plain text.
 */
export function buildDeterministicSummary(context: SummaryContext): string {
  const { recentTransfers, pendingRefunds } = context;
  const sentences: string[] = [];

  if (recentTransfers.length === 0) {
    sentences.push(
      "You haven't made any transfers yet — message us on WhatsApp to send your first one.",
    );
  } else {
    const count = recentTransfers.length;
    const noun = count === 1 ? 'transfer' : 'transfers';
    const last = recentTransfers[0];
    sentences.push(
      `Your ${count} most recent ${noun} are listed below — the latest, to ${last.recipient}, is ${last.status}.`,
    );
  }

  if (pendingRefunds > 0) {
    const noun = pendingRefunds === 1 ? 'refund' : 'refunds';
    sentences.push(
      `You have ${pendingRefunds} ${noun} being reviewed by our team — we'll confirm once it's approved.`,
    );
  }

  return sentences.join(' ');
}

const SUMMARY_TTL_SECONDS = 24 * 60 * 60; // 24h — the card is a digest, not live data
const DEFAULT_TIMEOUT_MS = 12_000;

const cacheKey = (partnerId: PartnerId, phone: string) => `summary:${partnerId}:${phone}`;

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
  store: { listTransfersByPhone(partnerId: PartnerId, phone: string, limit?: number): Promise<Transfer[]> };
  customers: { getCustomer(partnerId: PartnerId, phone: string): Promise<Customer | null> };
  partners: {
    getPartner(id: PartnerId): Promise<Partner | null>;
    ensureDefaultPartner(): Promise<Partner>;
  };
  dailyVolume: { getTodayCents(partnerId: PartnerId, phone: string): Promise<number> };
  /** Injectable model seam (defaults to the shared Claude client, task customer_summary). */
  chatFn?: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  timeoutMs?: number;
}

export function createCustomerSummarizer(deps: CustomerSummarizerDeps) {
  const chatFn = deps.chatFn ?? ((m: ChatMessage[], t: ChatTool[]) => chat(m, t, { task: 'customer_summary' }));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    /**
     * The customer's smart summary, from cache when fresh (`summary:<partnerId>:<phone>`,
     * 24h TTL, plain string — `automaticDeserialization:false` everywhere).
     * Returns null on ANY failure so the dashboard card simply doesn't render.
     */
    async getCustomerSummary(partnerId: PartnerId, phone: string): Promise<string | null> {
      try {
        const cached = await deps.redis.get(cacheKey(partnerId, phone));
        if (cached) return cached;

        const [customer, transfers, todayUsedCents] = await Promise.all([
          deps.customers.getCustomer(partnerId, phone),
          deps.store.listTransfersByPhone(partnerId, phone, 5),
          deps.dailyVolume.getTodayCents(partnerId, phone),
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
          resolveEffectiveSendLimits(partner, customer),
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

        await deps.redis.set(cacheKey(partnerId, phone), text, { ex: SUMMARY_TTL_SECONDS });
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
export function getCustomerSummary(partnerId: PartnerId, phone: string): Promise<string | null> {
  return summarizer().getCustomerSummary(partnerId, phone);
}
