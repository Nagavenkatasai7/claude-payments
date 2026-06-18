import { chat } from '@/lib/ollama';
import type { AuditEntry } from '@/lib/kyc-case-store';
import type { ChatMessage, Customer } from '@/lib/types';

// kyc-review-ai — the KYC review-decision copilot's one-shot AI helper (Tier-1
// quick win). ONE chat(messages, []) call — no tools, no agent loop, no
// retries. The copilot only ever SUGGESTS a decision and narrates a case
// summary; the HUMAN reviewer still types a reason and clicks Approve/Reject
// through the existing, audited reviewKycAction → kyc-case-store.review() path
// (the human-review-only invariant — Persona moves kycReviewState, a human
// moves kycStatus; the AI moves nothing). Any failure here is caught by the
// caller and degrades to a quiet "AI unavailable" — review work never blocks.

export const KYC_DECISIONS = ['approve', 'reject', 'need_more'] as const;
export type KycSuggestedDecision = (typeof KYC_DECISIONS)[number];

export const KYC_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type KycConfidence = (typeof KYC_CONFIDENCES)[number];

export interface KycReviewSuggestion {
  /** A 5-line, staff-facing narrative of the case. */
  summary: string;
  suggested_decision: KycSuggestedDecision;
  confidence: KycConfidence;
  top_reasons: string[];
}

// The forbidden-content rules — included verbatim in the system prompt below
// (tests/kyc-review-ai.test.ts guards their presence, à la ticket-ai).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const REVIEW_SYSTEM = `You are a KYC review copilot for a money-transfer service. A human compliance reviewer makes the final, audited decision — you ONLY help them read the case faster. You never approve, reject, clear, or block anyone; your output is a suggestion the human is free to ignore.

Given the customer's KYC case, respond with ONLY a JSON object and no other text:
{"summary": a 5-line plain-text case summary (one short sentence per line, '\\n'-separated): (1) who the customer is, (2) the declared identity details, (3) the screening result, (4) the Persona/review state, (5) the open question for the reviewer; "suggested_decision": one of "approve" | "reject" | "need_more"; "confidence": one of "low" | "medium" | "high"; "top_reasons": an array of 1-3 short reason strings}

Lean toward "need_more" when the case is ambiguous or data is missing — never overstate confidence. A watchlist or PEP hit is NEVER an auto-approve.

${GUARDRAILS}`;

function fieldLines(customer: Customer): string {
  const screening = customer.watchlistHit
    ? 'WATCHLIST HIT (hard hold)'
    : customer.pepHit
      ? 'PEP HIT'
      : 'clear';
  return [
    `KYC status: ${customer.kycStatus}`,
    `Review state: ${customer.kycReviewState ?? 'none'}`,
    `Screening: ${screening}`,
    `Persona inquiry: ${customer.kycInquiryId ?? customer.kycProviderRef ?? 'none'}`,
    `Declared full name: ${customer.fullName ?? 'unknown'}`,
    `Declared date of birth: ${customer.dateOfBirth ?? 'unknown'}`,
    `Declared occupation: ${customer.occupation ?? 'unknown'}`,
    `Declared source of funds: ${customer.sourceOfFunds ?? 'unknown'}`,
    `Self-declared PEP: ${customer.pepDeclared ? 'yes' : 'no'}`,
    `Government ID on file: ${customer.govIdType ?? 'unknown'} ending ${customer.idLast4 ?? 'unknown'}`,
    `Nationality: ${customer.nationality ?? 'unknown'}`,
    `Country: ${customer.senderCountry}`,
  ].join('\n');
}

function auditLines(audit: AuditEntry[]): string {
  if (audit.length === 0) return '(no prior KYC audit events)';
  return audit
    .map((e) => `${e.at} · ${e.actor} · ${e.action}${e.reason ? ` — ${e.reason}` : ''}`)
    .join('\n');
}

function clampReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .slice(0, 3);
}

/**
 * Suggest a KYC review decision + narrate the case. The model's structured
 * output is CLAMPED to the closed lists — an off-list decision collapses to
 * 'need_more', an off-list confidence to 'low', and top_reasons to a sanitized
 * string[] — so the caller can trust the shape unconditionally. The summary
 * falls back to a single placeholder line if the model omits it; an entirely
 * empty model reply throws (callers degrade to "AI unavailable").
 */
export async function suggestKycReview(
  customer: Customer,
  audit: AuditEntry[],
): Promise<KycReviewSuggestion> {
  const user: ChatMessage = {
    role: 'user',
    content:
      `Customer phone: ${customer.senderPhone}\n` +
      `First seen: ${customer.firstSeenAt}\n\n` +
      `KYC fields:\n${fieldLines(customer)}\n\n` +
      `KYC audit trail (oldest first):\n${auditLines(audit)}\n\n` +
      `Summarize the case and suggest a review decision.`,
  };
  const reply = await chat([{ role: 'system', content: REVIEW_SYSTEM }, user], []);
  const raw = (reply.content ?? '').trim();
  if (!raw) throw new Error('Empty AI response');

  let parsed: {
    summary?: unknown;
    suggested_decision?: unknown;
    confidence?: unknown;
    top_reasons?: unknown;
  } = {};
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]) as typeof parsed;
    } catch {
      /* unparseable — fall through to the clamped defaults */
    }
  }

  const suggested_decision = (KYC_DECISIONS as readonly unknown[]).includes(parsed.suggested_decision)
    ? (parsed.suggested_decision as KycSuggestedDecision)
    : 'need_more';
  const confidence = (KYC_CONFIDENCES as readonly unknown[]).includes(parsed.confidence)
    ? (parsed.confidence as KycConfidence)
    : 'low';
  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'No structured summary was produced — review the case fields directly.';
  const top_reasons = clampReasons(parsed.top_reasons);

  return { summary, suggested_decision, confidence, top_reasons };
}
