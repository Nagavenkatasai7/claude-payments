import { env } from './env';

// email — a minimal Resend sender (plain fetch, no SDK dependency). The only
// email path in the app today; used for "Partner with us" lead notifications,
// driven durably via the outbox ('email.send' effect). Reuse it for any future
// transactional email by enqueueing an 'email.send' row.

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email via Resend. If RESEND_API_KEY is unset, this is a no-op (warns +
 * returns) — the worker must NOT dead-letter when email simply isn't configured;
 * the lead is already persisted and visible in the admin dashboard. With a key,
 * a non-2xx response THROWS so the outbox retries/backoffs like every effect.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const key = env.resendApiKey;
  if (!key) {
    console.warn('sendEmail: RESEND_API_KEY unset — skipping email (lead still persisted).');
    return;
  }
  const recipients = msg.to.filter(Boolean);
  if (recipients.length === 0) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to: recipients,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}
