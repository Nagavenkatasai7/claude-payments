import { env } from './env';

export const RECIPIENT_TEMPLATE_NAME = 'transfer_delivered';
export const SCHEDULED_TEMPLATE_NAME = 'scheduled_payment_ready';
// Must exactly match the approved template's language in WhatsApp Manager.
// The transfer_delivered template was created with "English" => language code 'en'.
export const RECIPIENT_TEMPLATE_LANG = 'en';

import type { IncomingMessage } from './types';
export type { IncomingMessage }; // re-export for any caller using @/lib/whatsapp

interface WebhookShape {
  entry?: {
    changes?: {
      value?: {
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
      };
    }[];
  }[];
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

export async function sendText(to: string, text: string): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
}

export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
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
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp template send failed (${res.status}): ${body}`);
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
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
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
      }),
    },
  );

  if (res.ok) return;

  if (res.status === 470) {
    console.warn(
      'sendInteractive hit 24h-window error; falling back to sendText',
    );
    await sendText(to, fullBody);
    return;
  }

  const body = await res.text();
  throw new Error(`WhatsApp interactive send failed (${res.status}): ${body}`);
}

export interface ListRow {
  id: string;
  title: string;
}

/**
 * Send an interactive LIST message (WhatsApp Flows scaffolding). Same Graph API
 * envelope as sendInteractive; same HTTP-470 → sendText fallback. On any other
 * non-OK status it THROWS so the caller can fall back to buttons. Row ids carry
 * the existing recipient:<phone> / recipient:new grammar, so parseIncoming's
 * list_reply branch and parseButtonId need no changes. Gated behind
 * env.whatsappFlowsEnabled at the call site — flag off ⇒ this is never reached.
 */
export async function sendList(
  to: string,
  bodyText: string,
  buttonText: string,
  rows: ListRow[],
): Promise<void> {
  if (rows.length === 0 || rows.length > 10) {
    throw new Error(`sendList: WhatsApp accepts 1-10 list rows (got ${rows.length}).`);
  }
  const numbered = rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
  const fullBody = `${bodyText}\n\n${numbered}`;

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonText,
            sections: [{ rows: rows.map((r) => ({ id: r.id, title: r.title })) }],
          },
        },
      }),
    },
  );

  if (res.ok) return;

  if (res.status === 470) {
    console.warn('sendList hit 24h-window error; falling back to sendText');
    await sendText(to, fullBody);
    return;
  }

  const body = await res.text();
  throw new Error(`WhatsApp list send failed (${res.status}): ${body}`);
}
