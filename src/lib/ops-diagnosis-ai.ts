import { chat } from '@/lib/ollama';
import type { ChatMessage } from '@/lib/types';

// ops-diagnosis-ai — the operations copilot's one-shot diagnosis helper (U5).
// A "Tier-1 quick win": when a transfer is stuck in 'paid' with no delivery
// confirmation, or an outbox effect has exhausted its retries and gone to the
// dead-letter queue, a platform-ops staff member clicks "Diagnose" and the AI
// SYNTHESIZES a rationale — what likely went wrong and what to do next.
//
// Strictly rung-1 autonomy (docs/AGENTIC-ARCHITECTURE.md): the model READS a
// MASKED bundle and DRAFTS a diagnosis; it NEVER executes anything. The actual
// remediation is the existing audited retryDeadAction / dismissDeadAction the
// staff member explicitly clicks. ONE chat(messages, []) call — no tools, no
// agent loop, no retries. Any failure is caught by the caller and degrades to a
// quiet "AI unavailable" — manual ops work never blocks.
//
// The model's structured fields are CLAMPED to closed lists with safe defaults,
// so callers can trust the shape unconditionally; the real value is the
// `rationale` prose. The deterministic facts (sibling dead-row count, the
// provider type, masked transfer state) are computed by the CALLER with SQL/
// regex and handed to the model as context — the model never clusters or counts.

// failure_class — what kind of failure this is. Closed list; an off-list value
// from the model collapses to 'unknown'.
export const OPS_FAILURE_CLASSES = [
  'bad_settlement_url',
  'signature_mismatch',
  'partner_5xx',
  'meta_template_reject',
  'provider_unconfigured',
  'unknown',
] as const;
export type OpsFailureClass = (typeof OPS_FAILURE_CLASSES)[number];

// suggested_action — the next human move. Closed list; these map onto the
// EXISTING audited ops affordances (retry / dismiss / escalate). The model
// SUGGESTS; the staff member clicks. Off-list collapses to 'investigate'.
export const OPS_SUGGESTED_ACTIONS = [
  'retry',
  'dismiss',
  'reconfigure_provider',
  'contact_partner',
  'escalate',
  'investigate',
] as const;
export type OpsSuggestedAction = (typeof OPS_SUGGESTED_ACTIONS)[number];

// blast_radius — how widespread the fault looks, informed by the deterministic
// sibling count the caller supplies. Off-list collapses to 'isolated'.
export const OPS_BLAST_RADII = ['isolated', 'cluster', 'systemic'] as const;
export type OpsBlastRadius = (typeof OPS_BLAST_RADII)[number];

export interface OpsDiagnosis {
  failure_class: OpsFailureClass;
  suggested_action: OpsSuggestedAction;
  blast_radius: OpsBlastRadius;
  rationale: string;
}

// The masked, deterministic bundle the route assembles and hands to diagnose().
// Either a stuck transfer OR a dead outbox row is present (the route resolves
// the subjectId to exactly one). `siblingDeadCount` is the DETERMINISTIC count
// of other dead rows whose last_error shares this one's prefix — computed in SQL
// by the caller, NOT by the model.
export interface OpsDiagnosisBundle {
  subjectKind: 'stuck_transfer' | 'dead_letter';
  // Stuck-transfer facts (masked default ledger read — no full payout destination).
  transfer?: {
    id: string;
    status: string;
    partnerId: string;
    settlementPartnerId?: string;
    amount: string;
    paidAgeMinutes: number;
    providerType: string;
  };
  // Dead-letter facts.
  deadLetter?: {
    id: number;
    kind: string;
    attempts: number;
    lastError: string;
    providerType: string;
    ageMinutes: number;
    siblingDeadCount: number; // deterministic cluster size (this row excluded)
  };
}

// The forbidden-content rules — included verbatim in EVERY system prompt
// (tests/ops-diagnosis-ai.test.ts guards their presence, à la ticket-ai).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const DIAGNOSE_SYSTEM = `You are an operations copilot for a money-transfer platform. You help platform ops staff triage a STUCK transfer or a DEAD outbox effect (an external side-effect that exhausted its retries). Read the provided facts and respond with ONLY a JSON object, no other text:
{"failure_class": one of "bad_settlement_url" | "signature_mismatch" | "partner_5xx" | "meta_template_reject" | "provider_unconfigured" | "unknown", "suggested_action": one of "retry" | "dismiss" | "reconfigure_provider" | "contact_partner" | "escalate" | "investigate", "blast_radius": one of "isolated" | "cluster" | "systemic", "rationale": a short plain-text paragraph (2-3 sentences) explaining what likely went wrong and why you chose that action — reference only the facts given.}
You only DIAGNOSE. You never retry, dismiss, or change anything — a human runs the audited action. Use the sibling dead-row count to judge blast_radius: 0 siblings is isolated, a few is a cluster, many is systemic.

${GUARDRAILS}`;

function clamp<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return (list as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * Diagnose ONE stuck transfer or dead outbox effect. ONE chat(messages, [])
 * call — no tools, ever. The structured fields are CLAMPED to the closed lists
 * (off-list ⇒ the safe default); the `rationale` is the real AI value and MUST
 * be non-empty (an empty reply throws, so the caller degrades to "AI
 * unavailable"). The bundle is already MASKED and its deterministic facts
 * (sibling count, provider type) are computed by the caller — the model only
 * synthesizes prose and picks from the closed lists.
 */
export async function diagnoseOps(bundle: OpsDiagnosisBundle): Promise<OpsDiagnosis> {
  const user: ChatMessage = { role: 'user', content: bundleText(bundle) };
  const reply = await chat([{ role: 'system', content: DIAGNOSE_SYSTEM }, user], []);
  const raw = reply.content ?? '';

  let parsed: {
    failure_class?: unknown;
    suggested_action?: unknown;
    blast_radius?: unknown;
    rationale?: unknown;
  } = {};
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]) as typeof parsed;
    } catch {
      /* unparseable — fall through to clamped defaults; rationale stays raw */
    }
  }

  const failure_class = clamp(OPS_FAILURE_CLASSES, parsed.failure_class, 'unknown');
  const suggested_action = clamp(OPS_SUGGESTED_ACTIONS, parsed.suggested_action, 'investigate');
  const blast_radius = clamp(OPS_BLAST_RADII, parsed.blast_radius, 'isolated');

  // The rationale is the load-bearing AI output. Prefer the parsed field; fall
  // back to the trimmed raw reply (the model occasionally returns bare prose).
  const rationale = (typeof parsed.rationale === 'string' ? parsed.rationale : raw).trim();
  if (!rationale) throw new Error('Empty AI response');

  return { failure_class, suggested_action, blast_radius, rationale };
}

function bundleText(bundle: OpsDiagnosisBundle): string {
  if (bundle.subjectKind === 'dead_letter' && bundle.deadLetter) {
    const d = bundle.deadLetter;
    return (
      `Subject: a DEAD outbox effect (exhausted all retries).\n` +
      `Effect kind: ${d.kind}\n` +
      `Provider type: ${d.providerType}\n` +
      `Attempts: ${d.attempts}\n` +
      `Age: ${d.ageMinutes} minutes\n` +
      `Last error: ${d.lastError}\n` +
      `Sibling dead rows with the same error prefix: ${d.siblingDeadCount} (this row excluded)\n\n` +
      `Diagnose the failure and suggest the next ops action.`
    );
  }
  const t = bundle.transfer;
  if (t) {
    return (
      `Subject: a transfer STUCK in 'paid' with no delivery confirmation.\n` +
      `Transfer: ${t.id}\n` +
      `Status: ${t.status}\n` +
      `Partner: ${t.partnerId}` +
      (t.settlementPartnerId ? ` (settles via ${t.settlementPartnerId})` : '') +
      `\n` +
      `Settlement provider type: ${t.providerType}\n` +
      `Amount: ${t.amount}\n` +
      `Paid: ${t.paidAgeMinutes} minutes ago\n\n` +
      `Diagnose why delivery has not been confirmed and suggest the next ops action.`
    );
  }
  // Defensive: an empty bundle still produces a valid prompt the model can answer.
  return `Subject: an unspecified stuck operations item. Diagnose conservatively and suggest the next ops action.`;
}

/**
 * Deterministic error-prefix used for sibling clustering (NOT the model's job).
 * Takes the leading slice of a last_error, lower-cased and whitespace-collapsed,
 * so that two rows that failed the same way (e.g. the same partner 502 page or
 * the same "fetch failed" connection error) share a prefix even when a trailing
 * id/timestamp differs. Empty/short errors return their own normalized form.
 */
export function errorPrefix(lastError: string | null | undefined, length = 40): string {
  const normalized = (lastError ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized.slice(0, length);
}
