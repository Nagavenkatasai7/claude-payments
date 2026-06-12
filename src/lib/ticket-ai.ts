import { chat } from '@/lib/ollama';
import type { RedisLike } from '@/lib/store';
import type { ChatMessage, Ticket, TicketMessage, TicketPriority } from '@/lib/types';

// ticket-ai — the support copilot's one-shot AI helpers (B3). Each function is
// ONE chat(messages, []) call — no tools, no agent loop, no retries. The
// copilot only ever DRAFTS text or SUGGESTS triage values; a staff member
// reviews and explicitly acts (the autonomy-ladder rung-1 contract from
// docs/AGENTIC-ARCHITECTURE.md — agents read state and draft proposals; only
// deterministic, audited code paths mutate). Any failure here is caught by the
// caller and degrades to a quiet "AI unavailable" — manual work never blocks.

export const TICKET_CATEGORIES = ['refund', 'delay', 'kyc', 'recipient', 'rates', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'urgent'];

export interface TriageSuggestion {
  category: TicketCategory;
  priority: TicketPriority;
}

// The forbidden-content rules — included verbatim in EVERY system prompt below
// (tests/ticket-ai.test.ts guards their presence, à la bot-content-guard).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const DRAFT_SYSTEM = `You are a support copilot for a money-transfer service. Draft ONE short, warm, professional reply a human support agent could send to the customer. Plain text only — no markdown, no signature, no placeholders like [name].

${GUARDRAILS}`;

const SUMMARY_SYSTEM = `You are a support copilot for a money-transfer service. Summarize the support case for a staff member in EXACTLY 5 short lines: (1) what the customer wants, (2) key facts so far, (3) current state, (4) what staff did last, (5) suggested next step. Plain text, one sentence per line.

${GUARDRAILS}`;

const TRIAGE_SYSTEM = `You are a support copilot for a money-transfer service. Classify the ticket. Respond with ONLY a JSON object: {"category": one of "refund" | "delay" | "kyc" | "recipient" | "rates" | "other", "priority": one of "low" | "normal" | "urgent"}. No other text.

${GUARDRAILS}`;

function threadText(messages: TicketMessage[]): string {
  return messages
    .map((m) => {
      const who =
        m.actorType === 'customer' ? 'Customer'
        : m.actorType === 'system' ? 'System'
        : `Support (${m.actorId})`;
      return `${who}${m.internal ? ' [internal note]' : ''}: ${m.body}`;
    })
    .join('\n');
}

function contentOf(reply: ChatMessage): string {
  const text = (reply.content ?? '').trim();
  if (!text) throw new Error('Empty AI response');
  return text;
}

/**
 * Draft ONE suggested customer reply. Internal notes are filtered OUT before
 * the model ever sees the thread — a customer-facing draft must be built only
 * from what the customer can already see (defense-in-depth on top of the
 * system-prompt rules).
 */
export async function draftReply(
  ticket: Ticket,
  messages: TicketMessage[],
  customerContext: string,
): Promise<string> {
  const visible = messages.filter((m) => !m.internal);
  const user: ChatMessage = {
    role: 'user',
    content:
      `Subject: ${ticket.subject}\n` +
      `Status: ${ticket.status} · Priority: ${ticket.priority}` +
      `${ticket.category ? ` · Category: ${ticket.category}` : ''}\n` +
      (customerContext ? `Context: ${customerContext}\n` : '') +
      `\nConversation so far:\n${threadText(visible)}\n\nDraft the next support reply.`,
  };
  const reply = await chat([{ role: 'system', content: DRAFT_SYSTEM }, user], []);
  return contentOf(reply);
}

/** A 5-line staff-facing case summary (sees the full thread incl. internal notes). */
export async function summarizeCase(ticket: Ticket, messages: TicketMessage[]): Promise<string> {
  const user: ChatMessage = {
    role: 'user',
    content:
      `Subject: ${ticket.subject}\n` +
      `Status: ${ticket.status} · Priority: ${ticket.priority}` +
      `${ticket.category ? ` · Category: ${ticket.category}` : ''}\n` +
      `Opened: ${ticket.createdAt}\n\nFull thread:\n${threadText(messages)}`,
  };
  const reply = await chat([{ role: 'system', content: SUMMARY_SYSTEM }, user], []);
  return contentOf(reply);
}

/**
 * Suggest {category, priority} for a ticket. The model's output is CLAMPED to
 * the closed lists — an off-list category collapses to 'other', an off-list
 * priority to 'normal' — so callers can trust the shape unconditionally.
 */
export async function triageSuggest(
  subject: string,
  firstMessage: string,
): Promise<TriageSuggestion> {
  const user: ChatMessage = {
    role: 'user',
    content: `Subject: ${subject}\nFirst message: ${firstMessage}`,
  };
  const reply = await chat([{ role: 'system', content: TRIAGE_SYSTEM }, user], []);
  const raw = reply.content ?? '';
  let parsed: { category?: unknown; priority?: unknown } = {};
  const match = raw.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]) as { category?: unknown; priority?: unknown };
    } catch {
      /* unparseable — fall through to the clamped defaults */
    }
  }
  const category = (TICKET_CATEGORIES as readonly unknown[]).includes(parsed.category)
    ? (parsed.category as TicketCategory)
    : 'other';
  const priority = (PRIORITIES as readonly unknown[]).includes(parsed.priority)
    ? (parsed.priority as TicketPriority)
    : 'normal';
  return { category, priority };
}

// ── Per-staff copilot rate limit (60 calls/hour) ─────────────────────────────
//
// Fixed window keyed on the hour, same INCR+EXPIRE shape as ip-rate-limit.
// Callers (the /api/copilot routes) fail OPEN on Redis errors — a limiter
// outage must never take the copilot down with it.

export const COPILOT_RATE_LIMIT_PER_HOUR = 60;

export async function checkCopilotRateLimit(
  redis: RedisLike,
  username: string,
  opts: { limit?: number; now?: number } = {},
): Promise<boolean> {
  const limit = opts.limit ?? COPILOT_RATE_LIMIT_PER_HOUR;
  const window = Math.floor((opts.now ?? Date.now()) / 3_600_000);
  const key = `copilot:rl:${username}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 7200); // stale windows self-evict
  return count <= limit;
}
