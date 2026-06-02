// Shared WhatsApp deep-link helper for the SmartRemit landing page.
// Importable by both server components and client islands (no 'use client').
//
// Exact base form requested by the spec:
//   https://api.whatsapp.com/send/?phone=15556298293&text=<ENCODED>&type=phone_number&app_absent=0
// Phone is digits only (no +, spaces, or dashes) — a malformed number fails silently.

export const WA_PHONE = '15556298293';

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
