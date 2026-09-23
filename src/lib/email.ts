import nodemailer from 'nodemailer';
import { env } from './env';

// email — a minimal SMTP sender (Hostinger, via nodemailer). The only email path
// in the app today; used for "Partner with us" lead notifications, driven durably
// via the outbox ('email.send' effect). Reuse it for any future transactional
// email by enqueueing an 'email.send' row.

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * What a send actually did (Program-Fix 39, domain-11). A skip is REPORTED, never
 * silently dressed up as a send:
 *   - 'sent'                  — handed to the SMTP server;
 *   - 'skipped_unconfigured'  — SMTP_HOST/USER/PASS unset (checked first: the
 *                               configuration problem is the one worth reporting);
 *   - 'skipped_no_recipients' — configured, but `to` had no usable address.
 */
export type EmailOutcome = 'sent' | 'skipped_unconfigured' | 'skipped_no_recipients';

/**
 * True when the SMTP trio is present (presence only; never reads out a value).
 * sendEmail uses this SAME check, so the ops card and the sender cannot drift.
 */
export function emailConfigured(): boolean {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
}

/**
 * Send an email over SMTP. If SMTP creds are unset this does NOT send and
 * resolves 'skipped_unconfigured': the worker must not dead-letter when email
 * simply isn't configured (the lead is already persisted); it records the skip
 * instead (outbox-worker 'email.send'). When creds are present, a send failure
 * THROWS so the outbox retries/backoffs like every effect. Hostinger binds the
 * session to one mailbox, so the envelope MAIL FROM is pinned to SMTP_USER (a
 * mismatched From would 550).
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailOutcome> {
  if (!emailConfigured()) {
    console.warn('sendEmail: SMTP not configured (SMTP_HOST/USER/PASS unset) — skipping email (lead still persisted).');
    return 'skipped_unconfigured';
  }
  const recipients = msg.to.filter(Boolean);
  if (recipients.length === 0) return 'skipped_no_recipients';

  const transport = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465, // implicit TLS on 465; STARTTLS on 587
    auth: { user: env.smtpUser, pass: env.smtpPass },
  });

  await transport.sendMail({
    from: env.emailFrom || env.smtpUser,
    to: recipients,
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
    // Pin the envelope sender to the authenticated mailbox so Hostinger never
    // rejects a display-aliased From with a 550 "From must match" error.
    envelope: { from: env.smtpUser, to: recipients },
  });
  return 'sent';
}
