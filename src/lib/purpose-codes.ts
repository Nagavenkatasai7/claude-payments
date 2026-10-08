import type { TransferPurpose } from './types';

// purpose-codes — the transfer purpose (Raj #17; REQUIRED since the owner
// decision of 2026-10-08). When a customer says why they send money ("maa ki
// dawai ke liye", "bhai ki fees"), the bot fills `purpose`; when they do not, it
// asks once (prompt.ts PURPOSE, while the purpose.detect switch is on). The
// portal, scheduled sends and the Partner API require it too; a business bill
// payment is always 'business'. The purpose rides the transfer and the signed
// settlement instruction's compliance.purpose as before.
//
// The RBI purpose code is a SUGGESTION shown only to staff and the partner. It
// is never sent to the customer, never put in the prompt, and never set on the
// settlement instruction (purpose_code stays null there). Only family_support
// has a suggestion today; every other purpose stays null until confirmed.

/** Every TransferPurpose, in the order of the send_approve_picker enum. */
export const TRANSFER_PURPOSES = [
  'family_support', 'gift', 'education', 'medical', 'savings', 'bills', 'business', 'other',
] as const satisfies readonly TransferPurpose[];

/** The suggested RBI purpose code per purpose (null ⇒ no suggestion). Staff/partner display only. */
export const SUGGESTED_RBI_CODE: Readonly<Record<TransferPurpose, string | null>> = {
  family_support: 'P1301',
  gift: null,
  education: null,
  medical: null,
  savings: null,
  bills: null,
  business: null,
  other: null,
};

/** The suggested RBI code for a purpose, or null. Pure. */
export function suggestedRbiCode(p?: TransferPurpose | null): string | null {
  if (!p) return null;
  return Object.prototype.hasOwnProperty.call(SUGGESTED_RBI_CODE, p) ? SUGGESTED_RBI_CODE[p] : null;
}

/** English labels for staff and partner pages. */
export const PURPOSE_LABELS: Readonly<Record<TransferPurpose, string>> = {
  family_support: 'Family support',
  gift: 'Gift',
  education: 'Education',
  medical: 'Medical',
  savings: 'Savings',
  bills: 'Bills',
  business: 'Business',
  other: 'Other',
};

export interface PurposeHint {
  purpose: TransferPurpose;
  /** What a customer might say (English or Hinglish). */
  examples: readonly string[];
}

/** Example phrasings the prompt teaches. Only purposes with a clear everyday phrasing are listed. */
export const PURPOSE_HINTS: readonly PurposeHint[] = [
  { purpose: 'family_support', examples: ['maa ki dawai', 'ghar ka kharcha', 'Mom ko monthly', 'for my parents'] },
  { purpose: 'education', examples: ['bhai ki fees', 'college fees', 'tuition'] },
  { purpose: 'medical', examples: ['hospital ka bill', 'operation ke liye', 'surgery'] },
  { purpose: 'gift', examples: ['birthday gift', 'shaadi ka gift', 'Diwali gift'] },
  { purpose: 'bills', examples: ['bijli ka bill', 'phone bill'] },
  { purpose: 'savings', examples: ['apne account mein savings', 'FD ke liye'] },
];

export interface PurposeView {
  label: string;
  /** The suggested (unconfirmed) RBI code, or null. */
  suggestedCode: string | null;
}

/** What the staff and partner detail pages show for a transfer's purpose; null ⇒ the page shows "Not stated". Pure. */
export function purposeView(p?: TransferPurpose | null): PurposeView | null {
  if (!p || !Object.prototype.hasOwnProperty.call(PURPOSE_LABELS, p)) return null;
  return { label: PURPOSE_LABELS[p], suggestedCode: suggestedRbiCode(p) };
}

/** Narrow an untrusted value to a TransferPurpose; anything else (absent, unknown, a label) is undefined. Pure. */
export function parsePurpose(v: unknown): TransferPurpose | undefined {
  return typeof v === 'string' && (TRANSFER_PURPOSES as readonly string[]).includes(v) ? (v as TransferPurpose) : undefined;
}

/** The 8 choices in plain words, in enum order: "Family support, Gift, …, Business or Other". */
export const PURPOSE_CHOICES_TEXT: string = (() => {
  const labels = TRANSFER_PURPOSES.map((p) => PURPOSE_LABELS[p]);
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
})();

/** What a send tool tells the model when a required purpose is missing (never shown to the customer as is). */
export const PURPOSE_REQUIRED_HINT =
  `Ask the customer once why they are sending this money, listing the choices in plain words: ${PURPOSE_CHOICES_TEXT} ` +
  "(in Hinglish for a Hinglish customer). Then call the same tool again with the same details plus purpose.";
