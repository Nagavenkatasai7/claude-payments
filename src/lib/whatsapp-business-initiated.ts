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
import { isInServiceWindow, isWindowError, WhatsAppSendError } from './whatsapp-errors';
import type { PartnerId } from './types';

export type SendOutcome =
  | { ok: true; via: 'text' | 'template' }
  | { ok: false; code?: number; reason: 'send_failed' | 'outside_window_no_template'; error?: unknown };

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

function failed(error: unknown): SendOutcome {
  const code = error instanceof WhatsAppSendError ? error.code : undefined;
  return code === undefined
    ? { ok: false, reason: 'send_failed', error }
    : { ok: false, code, reason: 'send_failed', error };
}

async function attempt(fn: () => Promise<void>, via: 'text' | 'template'): Promise<SendOutcome> {
  try {
    await fn();
    return { ok: true, via };
  } catch (err) {
    return failed(err);
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
