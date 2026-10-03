// Program-Fix 25 PR A — a business-initiated send that REPORTS its outcome.
// For NEW call sites only (today: the ops.alert template path in the outbox
// worker). Existing callers keep sendTemplateOrText's template-first order.
//
// Meta: "Template messages are the only type of message that can be sent to
// WhatsApp users outside of a customer service window"
// (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).

import { env } from './env';
import { logWarn } from './log';
import { sendTemplate as realSendTemplate, sendText as realSendText, type WaCreds } from './whatsapp';
import { isInServiceWindow, isWindowError, sendOutcomeFromError, WhatsAppSendError, type SendOutcome } from './whatsapp-errors';
import type { PartnerId } from './types';

// Program-Fix 25 PR B: the type moved to the pure whatsapp-errors.ts (whatsapp.ts
// returns it too); re-exported so existing imports keep working.
export type { SendOutcome } from './whatsapp-errors';

export interface BusinessTemplate {
  name: string;
  lang: string;
  params: string[];
}

type SendTextFn = (to: string, text: string, creds?: WaCreds) => Promise<void>;
type SendTemplateFn = (to: string, name: string, lang: string, params: string[], creds?: WaCreds) => Promise<void>;
type WindowReader = { getLastInboundAt(partnerId: PartnerId, phone: string): Promise<string | null> };

export interface BusinessInitiatedOpts {
  /** The tenant whose `lastmsg:` marker decides the window (flag ON only). */
  partnerId: PartnerId;
  /** DI for tests / the worker; defaults to the real store (read only when the flag is ON). */
  store?: WindowReader;
  sendText?: SendTextFn;
  sendTemplate?: SendTemplateFn;
}

/**
 * Meta rejects a template parameter holding new-line / tab characters or more
 * than four consecutive spaces (Message Templates, "Parameters":
 * https://developers.facebook.com/docs/whatsapp/message-templates/creation/),
 * and caps a template body at 1,024 characters. Collapse every whitespace run
 * to one space and bound the length so a free-form message fits one variable.
 */
export const TEMPLATE_PARAM_MAX = 900;
export function toTemplateParam(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEMPLATE_PARAM_MAX ? `${flat.slice(0, TEMPLATE_PARAM_MAX - 1)}…` : flat;
}

/**
 * The 24-hour window decides (2026-10-03). A drop-in for a plain `sendText`
 * on an existing send path:
 *  - no template, or the customer wrote in the last 24 hours (the `lastmsg:`
 *    marker, 24-h TTL) ⇒ the plain text, byte-for-byte today's single call,
 *    nothing billed. If Graph ever refuses that text with a window error
 *    (131047 / 470) the template is tried once; should that fail too, the
 *    ORIGINAL window error is rethrown (retryable, as today).
 *  - no marker (outside the window) ⇒ the approved template. On the Cloud API
 *    an out-of-window text is accepted and then dropped (131047 arrives later
 *    on the status webhook, see whatsapp.ts sendTransactionOtp), so deciding
 *    up front is the only way the template is ever used. If the template
 *    fails (not approved yet: 132001), the plain text goes as today, and its
 *    error, if any, is what throws.
 * A marker that cannot be read counts as inside the window: today's text.
 */
export async function sendTextThenTemplate(
  to: string,
  msg: { text: string; template?: BusinessTemplate },
  creds: WaCreds | undefined,
  opts: { partnerId: PartnerId; store?: WindowReader; sendText?: SendTextFn; sendTemplate?: SendTemplateFn },
): Promise<void> {
  const sendText = opts.sendText ?? realSendText;
  const sendTemplate = opts.sendTemplate ?? realSendTemplate;
  const t = msg.template;
  if (!t) return sendText(to, msg.text, creds);
  const params = t.params.map(toTemplateParam);

  let inWindow = true;
  try {
    const store = opts.store ?? (await import('./store')).getStore();
    inWindow = Boolean(await store.getLastInboundAt(opts.partnerId, to));
  } catch {
    inWindow = true;
  }

  if (inWindow) {
    try {
      await sendText(to, msg.text, creds);
    } catch (err) {
      if (!isWindowError(err)) throw err;
      logWarn('whatsapp.window-template', 'text refused: 24-hour window closed; sending the approved template instead', { template: t.name });
      try {
        await sendTemplate(to, t.name, t.lang, params, creds);
      } catch (templateErr) {
        logWarn('whatsapp.window-template', 'template send failed too', { template: t.name, code: graphCode(templateErr) });
        throw err;
      }
    }
    return;
  }

  try {
    await sendTemplate(to, t.name, t.lang, params, creds);
  } catch (templateErr) {
    logWarn('whatsapp.window-template', 'outside the 24-hour window and the template failed; sending the plain text', {
      template: t.name, code: graphCode(templateErr),
    });
    await sendText(to, msg.text, creds);
  }
}

function graphCode(err: unknown): number | null {
  return err instanceof WhatsAppSendError ? err.code ?? null : null;
}

const ROW_TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const ROW_TEMPLATE_LANG_RE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;

/**
 * The optional `template` on a `whatsapp.text` outbox row (2026-10-03): the
 * approved template to try for a customer who may be outside the 24-hour
 * window, with the row's `body` as the free-form fallback. Anything malformed
 * (or an empty param, which Meta rejects) reads as no template, so the row
 * sends its plain text exactly as before. Params are flattened for Meta.
 */
export function rowTemplate(raw: unknown): BusinessTemplate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { name, lang, params } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !ROW_TEMPLATE_NAME_RE.test(name)) return undefined;
  if (typeof lang !== 'string' || !ROW_TEMPLATE_LANG_RE.test(lang)) return undefined;
  if (!Array.isArray(params) || !params.every((x) => typeof x === 'string')) return undefined;
  const flat = (params as string[]).map(toTemplateParam);
  if (flat.some((x) => x === '')) return undefined;
  return { name, lang, params: flat };
}

async function attempt(fn: () => Promise<void>, via: 'text' | 'template'): Promise<SendOutcome> {
  try {
    await fn();
    return { ok: true, via };
  } catch (err) {
    return sendOutcomeFromError(err);
  }
}

/**
 * Never throws for a send failure; returns `{ok:false}` carrying the last error.
 *
 * Flag OFF (default, `WHATSAPP_WINDOW_AWARE` unset): template if configured with
 * the free-form fallback, else free-form — exactly sendTemplateOrText's order.
 * Flag ON: inside the window free-form first, then the template on a window
 * rejection (131047 / HTTP 470); outside it the template, or `{ok:false,
 * reason:'outside_window_no_template'}` with NO Graph call.
 */
export async function sendBusinessInitiated(
  to: string,
  msg: { template?: BusinessTemplate; fallbackText: string },
  creds: WaCreds | undefined,
  opts: BusinessInitiatedOpts,
): Promise<SendOutcome> {
  const sendText = opts.sendText ?? realSendText;
  const sendTemplate = opts.sendTemplate ?? realSendTemplate;
  const { template, fallbackText } = msg;
  const viaText = () => attempt(() => sendText(to, fallbackText, creds), 'text');
  const viaTemplate = (t: BusinessTemplate) =>
    attempt(() => sendTemplate(to, t.name, t.lang, t.params, creds), 'template');

  if (!env.whatsappWindowAware) {
    if (!template) return viaText();
    const first = await viaTemplate(template);
    if (first.ok) return first;
    logWarn('whatsapp.business-initiated', 'template send failed; falling back to free-form text', {
      code: first.code ?? null,
    });
    return viaText();
  }

  const store = opts.store ?? (await import('./store')).getStore();
  const inWindow = await isInServiceWindow(store, opts.partnerId, to);
  if (inWindow) {
    const first = await viaText();
    if (first.ok || !template || !isWindowError(first.error)) return first;
    return viaTemplate(template);
  }
  if (!template) return { ok: false, reason: 'outside_window_no_template' };
  return viaTemplate(template);
}
