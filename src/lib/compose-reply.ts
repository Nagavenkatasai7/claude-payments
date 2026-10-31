/**
 * compose-reply (PR1) — the ONE order of a model reply the customer reads:
 *
 *   [redaction notice] [risk warning] model text [code-written quote text]
 *
 * - redaction notice: R49's one line when an account or card number the
 *   customer typed was hidden (the slot is empty until R49 fills it).
 * - risk warning: the scam warning a send tool returned (PURPOSE_SCAM_WARNING
 *   today; R48 fills it with the risk warnings).
 * - model text: what the model wrote, already formatted and stripped of URLs.
 * - quote text: R32, written by code from the get_quote result (tools.ts
 *   buildQuoteText), never by the model.
 *
 * The reply guard and the FALLBACK check read the RAW model text before this
 * runs. The agent appends its code-made link after the result. Pure.
 */

export interface ReplyParts {
  redactionNotice?: string;
  riskWarning?: string;
  modelText: string;
  quoteText?: string;
}

export function composeReply(parts: ReplyParts): string {
  const model = (parts.modelText ?? '').trim();
  const slot = (v: string | undefined) => {
    const t = (v ?? '').trim();
    // Never doubled when the model already wrote it word for word.
    return t && !model.includes(t) ? t : '';
  };
  return [slot(parts.redactionNotice), slot(parts.riskWarning), model, slot(parts.quoteText)].filter(Boolean).join('\n\n');
}
