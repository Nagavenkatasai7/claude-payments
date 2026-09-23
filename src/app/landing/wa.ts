// Shared WhatsApp deep-link helper for the SmartRemit landing page.
// Importable by both server components and client islands (no 'use client').
//
// Exact base form requested by the spec:
//   https://api.whatsapp.com/send/?phone=15556298293&text=<ENCODED>&type=phone_number&app_absent=0
// Phone is digits only (no +, spaces, or dashes) — a malformed number fails silently.
//
// Program-Fix 25 PR B (ui-01 / docs-03): the number is env-driven so the owner can
// move off Meta's sandbox number without a code change. NEXT_PUBLIC_WHATSAPP_NUMBER
// is inlined at BUILD time (client islands import this file), so it is read by its
// literal name here and a change needs a redeploy. Unset or malformed ⇒ today's
// number, byte-for-byte.

export const DEFAULT_WA_PHONE = '15556298293';

/** Digits-only 8–15 (E.164 without the +); anything else ⇒ the default. */
export function resolveWaPhone(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return /^\d{8,15}$/.test(v) ? v : DEFAULT_WA_PHONE;
}

/** The human label: a NANP number as "+1 555 629 8293", anything else as "+<digits>". */
export function formatWaPhone(digits: string): string {
  const m = /^1(\d{3})(\d{3})(\d{4})$/.exec(digits);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : `+${digits}`;
}

export const WA_PHONE = resolveWaPhone(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER);

/** Build a WhatsApp deep link with a URL-encoded prefilled message. */
export function waLink(message: string): string {
  const text = encodeURIComponent(message);
  return `https://api.whatsapp.com/send/?phone=${WA_PHONE}&text=${text}&type=phone_number&app_absent=0`;
}

// Prefilled messages — phrased as the customer, not as marketing copy.
export const WA_MESSAGES = {
  generic: 'Hi SmartRemit, I\'d like to send money.',
  /** Calculator default (matches the default 1000 USD → India). */
  calculatorDefault: 'Hi SmartRemit, I want to send 1000 USD to India.',
} as const;

/** Smart calculator prefill that carries the typed amount + destination. */
export function calculatorMessage(
  amount: number | string,
  sendCcy = 'USD',
  destination = 'India',
): string {
  return `Hi SmartRemit, I want to send ${amount} ${sendCcy} to ${destination}.`;
}

/** Corridor-tile prefill (destination only; the bot detects send currency). */
export function corridorMessage(country: string): string {
  return `Hi SmartRemit, I'd like to send money to ${country}.`;
}
