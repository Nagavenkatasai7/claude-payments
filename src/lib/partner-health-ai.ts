import { chat } from '@/lib/ollama';
import type { ChatMessage } from '@/lib/types';
import type { HealthBand } from '@/lib/partner-health';

// partner-health-ai — the one-shot AI narrator for the partner-health scorer
// (a rung-1 helper, same contract as ticket-ai.ts): ONE chat(messages, []) call,
// no tools, no agent loop, no retries. The deterministic scorer
// (partner-health.ts) decides the band + signals; this only WRITES a short,
// staff-facing "why at risk + concrete outreach" note from that fixed input. It
// proposes outreach; a human reads it and acts. Any failure is caught by the
// caller and the page simply omits the narration — the deterministic band +
// signals always render.

// The forbidden-content rules — included verbatim in the system prompt (copied
// from ticket-ai.ts; tests/partner-health.test.ts guards their presence).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const HEALTH_SYSTEM = `You are a partner-success copilot for a money-transfer infrastructure company. A deterministic scorer has already classified a PARTNER (a business that resells our service) into a health band and listed the signals behind it. Write a SHORT internal note for the account manager: 2-3 lines, plain text, no markdown. Line 1: why this partner is at risk, grounded ONLY in the given signals. Then ONE concrete outreach action the account manager could take next (e.g. a check-in message, an offer to help re-enable their rate feed, a setup call). This is internal — it is never shown to the partner or to any customer.

${GUARDRAILS}`;

/**
 * Narrate a partner's health: a 2-3 line "why + outreach" note for staff.
 * Pure passthrough of the scorer's output — the model sees only the band and
 * the already-redacted signal strings, never raw ledger data. Throws on an
 * empty model reply so the caller can degrade to "narration unavailable".
 */
export async function narratePartnerHealth(
  band: HealthBand,
  signals: string[],
): Promise<string> {
  const user: ChatMessage = {
    role: 'user',
    content:
      `Health band: ${band}\n` +
      `Signals:\n${signals.length ? signals.map((s) => `- ${s}`).join('\n') : '- (none)'}\n\n` +
      `Write the account manager's note.`,
  };
  const reply = await chat([{ role: 'system', content: HEALTH_SYSTEM }, user], []);
  const text = (reply.content ?? '').trim();
  if (!text) throw new Error('Empty AI response');
  return text;
}
