import { chat } from '@/lib/ollama';
import type { ChatMessage, Transfer } from '@/lib/types';

// review-triage-ai — the compliance-analyst copilot's one-shot AI helper (U6).
// ONE chat(messages, []) call — no tools, no agent loop, no retries. Strictly
// rung-1 autonomy (the autonomy-ladder contract from
// docs/AGENTIC-ARCHITECTURE.md): the copilot only SUGGESTS a disposition
// narrative for an in-review hold — the human analyst reads it and the existing
// deterministic, audited dashboard-ops actions (releaseTransfer / rejectTransfer)
// are the ONLY things that ever mutate. The AI NEVER executes a disposition.
// Any failure degrades to a quiet "AI unavailable" — manual triage never blocks.

export const URGENCIES = ['low', 'normal', 'high'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const SUGGESTED_PATHS = ['release', 'hold', 'escalate'] as const;
export type SuggestedPath = (typeof SUGGESTED_PATHS)[number];

export interface DispositionSuggestion {
  urgency: Urgency;
  suggested_path: SuggestedPath;
  rationale: string;
}

// The forbidden-content rules — included verbatim in the system prompt
// (tests/review-triage-ai.test.ts guards their presence, à la ticket-ai).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const TRIAGE_SYSTEM = `You are a compliance-triage copilot for a money-transfer service. A transfer is on an in-review HOLD awaiting a human analyst's decision. Given the masked review signals, propose a disposition for the analyst to consider. You only SUGGEST — a human makes the call and a separate audited action carries it out. Respond with ONLY a JSON object: {"urgency": one of "low" | "normal" | "high", "suggested_path": one of "release" | "hold" | "escalate", "rationale": a short one-or-two sentence justification grounded only in the provided signals}. No other text.

${GUARDRAILS}`;

// How large the captured amount is, in coarse bands — the model never sees the
// exact figure (defense-in-depth on top of the masked ledger read).
function amountBand(amountUsd: number): string {
  if (amountUsd >= 10000) return 'very large (≥ $10k)';
  if (amountUsd >= 3000) return 'large ($3k–$10k)';
  if (amountUsd >= 1000) return 'mid ($1k–$3k)';
  return 'small (< $1k)';
}

// Whole-hour age of the hold since funds were captured (paidAt). The
// "approaching threshold" signal the analyst cares about — a hold sitting near
// the 24h stale-review mark is more urgent than a fresh one.
function holdAgeHours(t: Transfer, now: number): number {
  const since = t.paidAt ?? t.createdAt;
  const ms = now - new Date(since).getTime();
  return Math.max(0, Math.floor(ms / 3_600_000));
}

// Extract the JSON object from a possibly-chatty model reply. The model is told
// to emit ONLY JSON, but a defensive parse must survive both a trailing sign-off
// AND a rationale string that itself contains a brace — a single greedy regex
// over-captures on the former, a single lazy one stops short on the latter. So
// try the whole trimmed string, then the greedy slice (first '{' → last '}'),
// then the lazy slice, returning the first that parses to an object.
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.match(/\{[\s\S]*\}/)?.[0],
    trimmed.match(/\{[\s\S]*?\}/)?.[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function clampUrgency(v: unknown): Urgency {
  return (URGENCIES as readonly unknown[]).includes(v) ? (v as Urgency) : 'normal';
}

function clampPath(v: unknown): SuggestedPath {
  return (SUGGESTED_PATHS as readonly unknown[]).includes(v) ? (v as SuggestedPath) : 'hold';
}

/**
 * Suggest a disposition {urgency, suggested_path, rationale} for ONE in-review
 * transfer. The model sees only MASKED signals — its compliance reasons, a
 * coarse amount band, whether EDD is required, and the age of the hold. The
 * output is CLAMPED to the closed lists: an off-list urgency collapses to
 * 'normal', an off-list path to 'hold' (the safe default — keep holding). An
 * empty rationale throws so the caller degrades to "AI unavailable".
 */
export async function suggestDisposition(
  t: Transfer,
  opts: { now?: number } = {},
): Promise<DispositionSuggestion> {
  const now = opts.now ?? Date.now();
  const reasons = t.complianceReasons.length ? t.complianceReasons.join('; ') : 'none recorded';
  const user: ChatMessage = {
    role: 'user',
    content:
      `Transfer ${t.id} is on an in-review hold.\n` +
      `Compliance reasons: ${reasons}\n` +
      `Amount band: ${amountBand(t.amountUsd)}\n` +
      `Corridor: ${t.sourceCountry} → ${t.destinationCountry}\n` +
      `EDD required: ${t.eddRequired ? 'yes' : 'no'}\n` +
      `Hold age: ${holdAgeHours(t, now)}h since payment captured\n\n` +
      `Suggest a disposition for the analyst.`,
  };
  const reply = await chat([{ role: 'system', content: TRIAGE_SYSTEM }, user], []);
  const parsed = extractJsonObject(reply.content ?? '') ?? {};
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!rationale) throw new Error('Empty AI response');
  return {
    urgency: clampUrgency(parsed.urgency),
    suggested_path: clampPath(parsed.suggested_path),
    rationale,
  };
}
