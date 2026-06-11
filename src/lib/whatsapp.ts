import { env } from './env';
import {
  authenticationTemplateParams,
  type AuthenticationTemplateComponent,
  verificationStatusParams,
  transactionOtpMessage,
  otpMessage,
  type VerificationState,
  TEMPLATE_LANG,
} from './whatsapp-templates';

export const RECIPIENT_TEMPLATE_NAME = 'transfer_delivered';
export const SCHEDULED_TEMPLATE_NAME = 'scheduled_payment_ready';
// Must exactly match the approved template's language in WhatsApp Manager.
// The transfer_delivered template was created with "English" => language code 'en'.
export const RECIPIENT_TEMPLATE_LANG = 'en';

import type { IncomingMessage } from './types';
export type { IncomingMessage }; // re-export for any caller using @/lib/whatsapp

/**
 * WL2 per-partner WhatsApp credentials. Every send function accepts an optional
 * trailing `creds` — absent ⇒ the env (shared SmartRemit) number, so existing
 * callers are byte-for-byte unchanged. A white-label partner's outbound traffic
 * is sent FROM their own number with their own token.
 */
export interface WaCreds {
  phoneNumberId: string;
  token: string;
}

interface WebhookShape {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: {
          type?: string;
          from?: string;
          id?: string;
          text?: { body?: string };
          interactive?: {
            type?: string;
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
        }[];
        statuses?: {
          id?: string;
          recipient_id?: string;
          status?: string;
          timestamp?: string;
          errors?: { code?: number; title?: string; message?: string }[];
        }[];
      };
    }[];
  }[];
}

/**
 * Normalized message-status callback (Meta `statuses` event: sent / delivered /
 * read / failed). We do NOT map `wamid` → transfer today, so the deliverable is
 * structured logging; the shape is future-mapping-ready (wamid + recipientId).
 */
export interface WebhookStatusEvent {
  wamid: string; // statuses[].id — the message id we'd map to a transfer later
  recipientId: string; // statuses[].recipient_id (the customer phone)
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp?: string;
  errorCode?: number; // first errors[].code when status === 'failed'
  errorTitle?: string; // first errors[].title
}

/**
 * Parse a Meta `statuses` webhook into normalized status events. Returns null
 * for anything that is not a statuses event (mirrors parseIncoming → null for
 * non-message payloads). Malformed entries (missing id or status) are skipped.
 */
export function parseStatusEvent(body: unknown): WebhookStatusEvent[] | null {
  try {
    const statuses = (body as WebhookShape)?.entry?.[0]?.changes?.[0]?.value
      ?.statuses;
    if (!statuses || statuses.length === 0) return null;

    const events: WebhookStatusEvent[] = [];
    for (const s of statuses) {
      if (!s.id || !s.status) continue; // defensive: skip malformed
      const event: WebhookStatusEvent = {
        wamid: s.id,
        recipientId: s.recipient_id ?? '',
        status: s.status,
      };
      if (s.timestamp) event.timestamp = s.timestamp;
      const firstError = s.errors?.[0];
      if (firstError) {
        if (typeof firstError.code === 'number') event.errorCode = firstError.code;
        if (firstError.title) event.errorTitle = firstError.title;
      }
      events.push(event);
    }
    if (events.length === 0) return null;
    return events;
  } catch {
    return null;
  }
}

/**
 * WL2: the receiving number's phone_number_id, present on EVERY Meta webhook
 * event (messages and statuses) at entry[].changes[].value.metadata. The route
 * uses it to resolve the owning partner BEFORE signature verification, so the
 * right partner's app secret is checked. Null when absent/malformed.
 */
export function parsePhoneNumberId(body: unknown): string | null {
  try {
    const pnid = (body as WebhookShape)?.entry?.[0]?.changes?.[0]?.value
      ?.metadata?.phone_number_id;
    return typeof pnid === 'string' && pnid !== '' ? pnid : null;
  } catch {
    return null;
  }
}

export function parseIncoming(body: unknown): IncomingMessage | null {
  try {
    const message = (body as WebhookShape)?.entry?.[0]?.changes?.[0]?.value
      ?.messages?.[0];
    if (!message || !message.from || !message.id) return null;

    if (message.type === 'text' && message.text?.body) {
      return {
        kind: 'text',
        from: message.from,
        text: message.text.body,
        messageId: message.id,
      };
    }
    if (
      message.type === 'interactive' &&
      message.interactive?.type === 'button_reply' &&
      message.interactive.button_reply?.id
    ) {
      return {
        kind: 'button',
        from: message.from,
        buttonId: message.interactive.button_reply.id,
        messageId: message.id,
      };
    }
    if (
      message.type === 'interactive' &&
      message.interactive?.type === 'list_reply' &&
      message.interactive.list_reply?.id
    ) {
      return {
        kind: 'button', // collapse to the existing button shape — route + parseButtonId reused unchanged
        from: message.from,
        buttonId: message.interactive.list_reply.id,
        messageId: message.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Per-user rate-limit backoff (error 131056 = >1 msg / 6s to the same user) ──
// Most of our sends are 1-per-user, so this is defense for bursts (e.g. a cron
// batch that fans out to the same number). Bounded linear backoff; on a
// non-rate-limit error we throw immediately (unchanged behavior).
const RATE_LIMIT_MAX_RETRIES = 2; // 1 initial attempt + 2 retries = 3 total
const RATE_LIMIT_BASE_DELAY_MS = 6500; // 6s window for 131056 + small margin

const GRAPH_MESSAGES_URL = (creds?: WaCreds) =>
  `https://graph.facebook.com/v21.0/${creds?.phoneNumberId ?? env.whatsappPhoneNumberId}/messages`;

function authedJsonInit(payload: unknown, creds?: WaCreds): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds?.token ?? env.whatsappToken}`,
    },
    body: JSON.stringify(payload),
  };
}

function isRateLimited(status: number, body: string): boolean {
  return status === 429 || body.includes('131056');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to the Graph API with bounded retry on a per-user rate limit (131056 /
 * HTTP 429). On success returns. On a non-rate-limit non-OK status it throws
 * immediately (one fetch). On a rate-limit status it waits `BASE * attempt` and
 * retries up to RATE_LIMIT_MAX_RETRIES times, then throws the last error so the
 * caller's existing fallback (e.g. sendTemplateOrText) still fires.
 */
async function postWithBackoff(
  url: string,
  init: RequestInit,
  errLabel: string,
): Promise<void> {
  let lastBody = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return;
    lastStatus = res.status;
    lastBody = await res.text();
    if (isRateLimited(res.status, lastBody) && attempt < RATE_LIMIT_MAX_RETRIES) {
      console.warn(
        `${errLabel}: rate limited (${res.status}); retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES} after backoff`,
      );
      await sleep(RATE_LIMIT_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    break;
  }
  throw new Error(`${errLabel} (${lastStatus}): ${lastBody}`);
}

export async function sendText(to: string, text: string, creds?: WaCreds): Promise<void> {
  return postWithBackoff(
    GRAPH_MESSAGES_URL(creds),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }, creds),
    'WhatsApp send failed',
  );
}

export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
  creds?: WaCreds,
): Promise<void> {
  return postWithBackoff(
    GRAPH_MESSAGES_URL(creds),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: 'body',
            parameters: bodyParams.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    }, creds),
    'WhatsApp template send failed',
  );
}

/**
 * Send a template that has a dynamic URL ("Visit website") button — the button's
 * URL ends in one `{{1}}` suffix variable (e.g. /pay/{{1}}). Separate from
 * sendTemplate so the live transfer_delivered send (body-only) is unaffected.
 * `buttonToken` must be a path-safe slug (no '/' or query chars) per the §3
 * dynamic-URL rule. Throws on any non-OK status; the caller (sendTemplateOrText)
 * owns the fallback.
 */
export async function sendTemplateWithButton(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
  buttonToken: string,
  creds?: WaCreds,
): Promise<void> {
  return postWithBackoff(
    GRAPH_MESSAGES_URL(creds),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: 'body',
            parameters: bodyParams.map((text) => ({ type: 'text', text })),
          },
          {
            type: 'button',
            sub_type: 'url',
            index: 0,
            parameters: [{ type: 'text', text: buttonToken }],
          },
        ],
      },
    }, creds),
    'WhatsApp template send failed',
  );
}

/**
 * Send a template whose `components` array is already fully built (body + any
 * button components). Mirrors sendTemplate/sendTemplateWithButton's Graph API
 * envelope but takes the components verbatim so an AUTHENTICATION template (body
 * code param + COPY_CODE url button param) can be sent without a bespoke body/
 * button signature. Throws on a non-OK status (no code is ever in the error —
 * the error is the Graph response body, which does not echo the params).
 */
export async function sendAuthTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components: AuthenticationTemplateComponent[],
): Promise<void> {
  return postWithBackoff(
    GRAPH_MESSAGES_URL(),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
    'WhatsApp auth template send failed',
  );
}

// Language for the AUTHENTICATION template — 'en', matching every other §3
// template (created as "English" => 'en', not 'en_US').
const OTP_TEMPLATE_LANG = 'en';

/** Mask a phone to its last 4 digits for safe logging (…1234). Never log the OTP. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `…${digits.slice(-4)}`;
}

/**
 * Deliver a one-time code over WhatsApp (spec §3c). The `code` MUST never appear
 * in a log line or a thrown error — only the masked (last-4) phone is logged.
 *
 * Dev mode (env.otpDevMode): log a masked-phone "code ready" line and RETURN
 * without a live send, so dev/staging works before the Meta AUTHENTICATION
 * template is approved. (The code itself is intentionally NOT logged; operators
 * read it from otp-store's dev surface, not from this line.)
 *
 * Live mode: try the approved AUTHENTICATION template (name from
 * env.whatsappAuthTemplate, lang 'en') with the code in BOTH the body and the
 * COPY_CODE url button. If that fails — most commonly because the template isn't
 * approved in WhatsApp Manager yet — fall back to a free-form `sendText` so an
 * in-session customer (within the 24-h window) still RECEIVES the code. This
 * mirrors sendTemplateOrText's degradation and the per-transaction OTP, and is
 * the reason a verification code now arrives even before the template is live.
 * The code never appears in a log line; a thrown Graph error never echoes the
 * params, and the free-form fallback message is built by the pure otpMessage().
 */
export async function sendOtpCode(phone: string, code: string): Promise<void> {
  if (env.otpDevMode) {
    // No code in the log; no live send (used for local/CI, never prod).
    console.log(`[otp] dev-mode: code ready for ${maskPhone(phone)}`);
    return;
  }
  // Templates are OPT-IN: no configured template ⇒ regular free-form message
  // immediately (the "inbuilt template" — otpMessage()), no doomed Graph call.
  // Free-form only delivers inside Meta's 24h customer-service window — the
  // testing-business mode until templates are approved in WhatsApp Manager.
  if (!env.whatsappAuthTemplate) {
    await sendText(phone, otpMessage(code));
    return;
  }
  try {
    await sendAuthTemplate(
      phone,
      env.whatsappAuthTemplate,
      OTP_TEMPLATE_LANG,
      authenticationTemplateParams(code),
    );
  } catch (err) {
    // Template path unavailable (e.g. not yet approved) → deliver in-session via
    // free-form text. Log only the masked phone + the error MESSAGE (never the
    // code, never the request body).
    console.warn(
      `OTP template send failed for ${maskPhone(phone)}; falling back to free-form text:`,
      err instanceof Error ? err.message : 'unknown error',
    );
    await sendText(phone, otpMessage(code));
  }
}

/**
 * Business-initiated send with graceful degradation. Runs the template send
 * (`send`); on ANY error — template not yet approved, HTTP 470 / 131047
 * outside-window, paused/disabled template, etc. — logs a warning and falls back
 * to the current free-form `sendText`. Until the §3 templates are approved in
 * WhatsApp Manager, every call lands via the fallback path. The inner try/catch
 * mirrors today's cron behavior: a free-form send legitimately fails when the
 * customer hasn't messaged in 24h, so it must be logged + swallowed (never
 * thrown) so one bad send doesn't abort a cron batch.
 */
export async function sendTemplateOrText(
  to: string,
  send: () => Promise<void>,
  fallbackText: string,
  creds?: WaCreds,
): Promise<void> {
  try {
    await send();
  } catch (err) {
    console.warn('Template send failed; falling back to free-form text:', err);
    try {
      await sendText(to, fallbackText, creds);
    } catch (textErr) {
      console.error('Fallback sendText also failed for', to, textErr);
    }
  }
}

export interface InteractiveButton {
  id: string;
  title: string;
}

/**
 * Send an interactive button message. WhatsApp Cloud API allows up to 3 reply
 * buttons in a single message. If the request fails with HTTP 470 (outside the
 * 24-hour customer-service window), we fall back to a plain text message with
 * a numbered list so the sender still sees the options.
 */
export async function sendInteractive(
  to: string,
  bodyText: string,
  buttons: InteractiveButton[],
  creds?: WaCreds,
): Promise<void> {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error(
      `sendInteractive: WhatsApp accepts 1-3 buttons (got ${buttons.length}).`,
    );
  }
  const numbered = buttons
    .map((b, i) => `${i + 1}. ${b.title}`)
    .join('\n');
  const fullBody = `${bodyText}\n\n${numbered}`;

  const res = await fetch(
    GRAPH_MESSAGES_URL(creds),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: fullBody },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }, creds),
  );

  if (res.ok) return;

  if (res.status === 470) {
    console.warn(
      'sendInteractive hit 24h-window error; falling back to sendText',
    );
    await sendText(to, fullBody, creds);
    return;
  }

  const body = await res.text();
  throw new Error(`WhatsApp interactive send failed (${res.status}): ${body}`);
}

export interface CtaButton {
  displayText: string;
  url: string;
}

/**
 * Interactive CTA-URL button. Opens the URL on tap (NO webhook callback).
 * Same HTTP-470 → sendText fallback and non-OK throw pattern as sendInteractive.
 */
export async function sendCtaUrl(
  to: string,
  bodyText: string,
  button: CtaButton,
  headerText?: string,
  footerText?: string,
  creds?: WaCreds,
): Promise<void> {
  if (!button.url.startsWith('https://')) throw new Error('sendCtaUrl: URL must be https://');
  if (button.displayText.length > 20) throw new Error('sendCtaUrl: displayText must be <= 20 chars');
  const fallbackText = `${bodyText}\n\n${button.displayText}\n${button.url}`;

  const res = await fetch(
    GRAPH_MESSAGES_URL(creds),
    authedJsonInit({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        ...(headerText && { header: { type: 'text', text: headerText } }),
        body: { text: bodyText },
        ...(footerText && { footer: { text: footerText } }),
        action: {
          name: 'cta_url',
          parameters: {
            display_text: button.displayText,
            url: button.url,
          },
        },
      },
    }, creds),
  );

  if (res.ok) return;

  // CTA-URL is a newer interactive type; if Meta rejects it for ANY reason (24h
  // window 470, unsupported type, etc.), degrade gracefully to a plain text with
  // the link inline rather than throwing — the customer still gets a tappable link.
  const body = await res.text().catch(() => '');
  console.warn(`sendCtaUrl failed (${res.status}: ${body}); falling back to sendText`);
  await sendText(to, fallbackText, creds);
}

/**
 * Phase 2 — notify a customer of a KYC verification state change. Uses the
 * per-state template name (env getter), degrading to free-form text via
 * sendTemplateOrText until the verification_* templates are Meta-approved
 * (mirrors the OTP/cron fail-soft pattern). Never throws.
 */
export async function sendVerificationStatus(
  phone: string,
  state: VerificationState,
  name?: string,
): Promise<void> {
  const params = verificationStatusParams(name ?? 'there', state);
  const templateName = {
    needed: env.whatsappVerificationNeededTemplate,
    in_progress: env.whatsappVerificationInProgressTemplate,
    received: env.whatsappVerificationInProgressTemplate,
    verified: env.whatsappVerificationVerifiedTemplate,
    failed: env.whatsappVerificationFailedTemplate,
  }[state];
  const fallbackText = `${params[0]}, ${params[1]}`;
  // Templates are OPT-IN: unconfigured ⇒ the free-form "inbuilt template"
  // directly (no doomed Graph call). sendTemplateOrText still guards the
  // configured path so a paused/rejected template degrades the same way.
  if (!templateName) {
    try {
      await sendText(phone, fallbackText);
    } catch (err) {
      console.warn(
        'sendVerificationStatus free-form send failed (out of 24h window?):',
        err instanceof Error ? err.message : 'unknown error',
      );
    }
    return;
  }
  await sendTemplateOrText(
    phone,
    () => sendTemplate(phone, templateName, TEMPLATE_LANG, params),
    fallbackText,
  );
}

/**
 * Phase 3 — deliver a per-transaction step-up OTP. A send is in-session (the
 * customer is actively paying), so free-form text works without an
 * AUTHENTICATION template. Never logs the code. Throws on a hard delivery
 * failure (the caller surfaces a generic error; the pay route still won't
 * finalize without a verified code, so a failed send never lets money through).
 */
export async function sendTransactionOtp(phone: string, code: string, creds?: WaCreds): Promise<void> {
  await sendText(phone, transactionOtpMessage(code), creds);
}
