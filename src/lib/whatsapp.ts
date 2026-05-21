import { env } from './env';

export interface IncomingMessage {
  from: string;
  text: string;
  messageId: string;
}

interface WebhookShape {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          type?: string;
          from?: string;
          id?: string;
          text?: { body?: string };
        }[];
      };
    }[];
  }[];
}

export function parseIncoming(body: unknown): IncomingMessage | null {
  try {
    const message = (body as WebhookShape)?.entry?.[0]?.changes?.[0]?.value
      ?.messages?.[0];
    if (!message || message.type !== 'text') return null;
    if (!message.from || !message.id || !message.text?.body) return null;
    return {
      from: message.from,
      text: message.text.body,
      messageId: message.id,
    };
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
