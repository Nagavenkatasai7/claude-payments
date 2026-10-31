import { boundUntrustedText } from './untrusted-text';

/**
 * hold-replies — the ONLY source of the fixed text a customer is shown when a
 * transfer is held, cannot go ahead, needs more details, or is over a sending
 * limit (R30, no tipping-off). The WhatsApp bot, the web chat, the customer
 * portal and the AI-app (MCP) server all read their wording here, so one
 * approved version covers every surface. Support staff use the same scripts.
 *
 * Why the wording is fixed: the Bank Secrecy Act forbids telling anyone that a
 * suspicious activity report was or may be filed (31 U.S.C. 5318(g)(2)). A
 * reply that names a review, a screening result or a threshold, or that says
 * exactly how much is left today, lets a customer probe what triggers a hold.
 *
 * Rules every entry follows (tests/hold-replies.test.ts runs a banned-word check
 * over the whole table):
 *  - no reason: never a review, a report, a screening result or a flag;
 *  - no figure: no digit and no currency sign, so no threshold, no limit and
 *    no remaining amount;
 *  - later changes ADD entries here and never write hold or limit text elsewhere.
 *
 * The HELP suffix, the receipt link and the licensed-provider line are
 * parameters (FixedReplyOptions), so a later change to any of them is one edit.
 */

/** The wording version the partner's compliance officer (MLRO) approves. Bump it on any text change. */
export const HOLD_REPLIES_VERSION = '2026-10-31.1 (draft, awaiting MLRO approval)';

export const FIXED_REPLIES = {
  /** A paid transfer that is held before payout (status in_review). */
  hold: "Your transfer is being processed. We'll message you as soon as there is an update. You don't need to do anything right now.",
  /** A transfer that cannot go ahead (it was never charged). */
  block: "This transfer can't be completed, and you have not been charged.",
  /** Before the approval card: the two extra questions (source of funds and occupation). */
  edd_ask: 'Before this transfer we need two quick details: where the money comes from, and your occupation.',
  /** The same two questions, on a surface that cannot ask them (web chat, portal, AI apps). */
  edd_elsewhere:
    'This transfer needs a couple of extra details that can only be given in our WhatsApp chat. Message us on WhatsApp to finish it.',
  /** Over the daily sending cap. */
  cap_daily: 'This is more than you can send today. You can send a smaller amount, or try again on another day.',
  /** Over the per-transfer cap. */
  cap_per_transfer: 'This is more than you can send in one transfer. You can send a smaller amount.',
  /** The intro window ended without a verified identity. */
  cap_verify: 'Please verify your identity to keep sending.',
  /** Sending is switched off for this customer (for example a failed verification). */
  cap_unavailable: 'Sending is not available on this account right now.',
  /** Any other refusal of a send. */
  cannot_complete: "This transfer can't be completed right now.",
  /** A refund asked for while the transfer is held. */
  refund_while_held: "A refund can't be requested for this transfer yet. We'll message you as soon as there is an update.",
  /** A held business bill payment (B2B), for example when the buyer asks to cancel it. */
  payment_held: "This payment is being processed. We'll message you as soon as there is an update.",
  /** The status label of a held transfer, inside a list or a sentence. */
  status_held: "processing, we'll message you",
  /** The held step on a transfer's timeline (the customer portal). */
  timeline_held: "Processing. We'll message you as soon as there is an update.",
  /** The status pill of a held transfer on customer surfaces (the portal, its receipt, /account). */
  label_held: 'Processing',
} as const;

export type FixedReplyKind = keyof typeof FIXED_REPLIES;

/** The fixed text for a held transfer. */
export const HOLD_REPLY: string = FIXED_REPLIES.hold;
/** The fixed text for a transfer that cannot go ahead. */
export const BLOCK_REPLY: string = FIXED_REPLIES.block;
/** The fixed explanation before the two extra questions. */
export const EDD_ASK: string = FIXED_REPLIES.edd_ask;

/**
 * Points the customer to a person (R43): the HELP keyword, which the agent.turn
 * router (turn-router.ts) answers with a support case even when the model is down.
 */
export const HELP_SUFFIX = 'Reply HELP to reach a person.';

const RECEIPT_LABEL = 'Receipt:';
const RECEIPT_MAX = 300;
const PROVIDER_LINE_MAX = 200;

export interface FixedReplyOptions {
  /** Append HELP_SUFFIX (a way out on every dead end). */
  help?: boolean;
  /** A receipt link made by our code, added on its own line. */
  receiptUrl?: string;
  /** The licensed-provider line ("Payments by <partner>, licensed by <regulator>"); empty until PR4. */
  providerLine?: string;
}

/**
 * One fixed reply with its optional parts, always in this order: the entry, the
 * HELP suffix, then the receipt link and the provider line on their own lines.
 * Blank parameters add nothing. The receipt link and the provider line are
 * flattened to one line each, so neither can add lines of its own.
 */
export function fixedReply(kind: FixedReplyKind, opts: FixedReplyOptions = {}): string {
  let text: string = FIXED_REPLIES[kind];
  if (opts.help) text = `${text} ${HELP_SUFFIX}`;
  const receipt = boundUntrustedText(opts.receiptUrl, RECEIPT_MAX).trim();
  if (receipt) text = `${text}\n${RECEIPT_LABEL} ${receipt}`;
  const provider = boundUntrustedText(opts.providerLine, PROVIDER_LINE_MAX).trim();
  if (provider) text = `${text}\n${provider}`;
  return text;
}

/** Which fixed reply a cap refusal reason (tier-rules.ts CapReason) gets. Unknown ⇒ cannot_complete. */
export function capRefusalKind(reason: unknown): FixedReplyKind {
  switch (reason) {
    case 'over_daily_cap':
      return 'cap_daily';
    case 'over_per_transfer_cap':
      return 'cap_per_transfer';
    case 'verification_required_after_window':
      return 'cap_verify';
    case 'verification_rejected':
      return 'cap_unavailable';
    default:
      return 'cannot_complete';
  }
}

/** The fixed refusal for a cap reason: no figure, no reason beyond the plain kind. */
export function capRefusalReply(reason: unknown, opts: FixedReplyOptions = {}): string {
  return fixedReply(capRefusalKind(reason), opts);
}

// ── R43: the replies to HELP and to a request for a person ──────────────────
// The worker's router opens a support case (help-case.ts openHelpCase) and
// answers with one of these, without the model. Each opening line carries the
// {case} slot; the second sentence says where a teammate's answer arrives (a
// staff reply reaches WhatsApp or Telegram only as a link notice, never inside
// the chat). agent_paused is the fixed, non-AI answer while the agent is paused
// (R26's slot in turn-router.ts). No response-time promise (owner decision, Program-Fix 34). The
// Hindi entries are Hinglish, the language the bot answers Hindi in. Wording is
// a draft for the owner and a native speaker to approve (HOLD_REPLIES_VERSION).

export const HELP_CASE_REPLIES = {
  en: {
    case_opened: "I've opened a case so a person on our team can help you. Your case number is {case}.",
    case_money: "I've opened a case so a person on our team can check this payment with you. Your case number is {case}.",
    case_unauthorised:
      "I've opened a case so a person on our team can help you. Your case number is {case}. Please don't share any code we send you with anyone.",
    where_whatsapp: "When a teammate replies, you'll get a message here with a link to read it (sign in with this WhatsApp number).",
    where_telegram: "When a teammate replies, you'll get a message here with a link to read it (sign in with this phone number).",
    where_web: 'A teammate will reply on the Support page of your account.',
    agent_paused: "Our assistant can't answer messages right now. Reply HELP to reach a person.",
  },
  hinglish: {
    case_opened: 'Maine aapke liye ek case khol diya hai, taaki hamari team ka koi vyakti aapki madad kar sake. Aapka case number hai {case}.',
    case_money: 'Maine ek case khol diya hai, taaki hamari team ka koi vyakti aapke saath is payment ko check kar sake. Aapka case number hai {case}.',
    case_unauthorised:
      'Maine ek case khol diya hai, taaki hamari team ka koi vyakti aapki madad kar sake. Aapka case number hai {case}. Hamara bheja hua koi bhi code kisi ke saath share na karein.',
    where_whatsapp: 'Jab koi teammate jawab dega, aapko yahan ek link ke saath message milega (isi WhatsApp number se sign in karein).',
    where_telegram: 'Jab koi teammate jawab dega, aapko yahan ek link ke saath message milega (isi phone number se sign in karein).',
    where_web: 'Hamari team aapke account ke Support page par jawab degi.',
    agent_paused: 'Hamara assistant abhi messages ka jawab nahi de sakta. Kisi vyakti se baat karne ke liye HELP likhein.',
  },
  es: {
    case_opened: 'Abrí un caso para que una persona de nuestro equipo le ayude. Su número de caso es {case}.',
    case_money: 'Abrí un caso para que una persona de nuestro equipo compruebe este pago con usted. Su número de caso es {case}.',
    case_unauthorised:
      'Abrí un caso para que una persona de nuestro equipo le ayude. Su número de caso es {case}. No comparta con nadie ningún código que le enviemos.',
    where_whatsapp: 'Cuando alguien del equipo responda, recibirá aquí un mensaje con un enlace para leerlo (inicie sesión con este número de WhatsApp).',
    where_telegram: 'Cuando alguien del equipo responda, recibirá aquí un mensaje con un enlace para leerlo (inicie sesión con este número de teléfono).',
    where_web: 'Nuestro equipo le responderá en la página de Soporte de su cuenta.',
    agent_paused: 'Nuestro asistente no puede responder mensajes en este momento. Responda HELP para hablar con una persona.',
  },
} as const;

export type HelpReplyLang = keyof typeof HELP_CASE_REPLIES;
export type HelpCaseReplyKind = 'case_opened' | 'case_money' | 'case_unauthorised';
export type HelpReplyChannel = 'whatsapp' | 'telegram' | 'web';

const CASE_ID_MAX = 64;

/** Where a teammate's answer arrives, for a channel. */
export function helpWhereLine(lang: HelpReplyLang, channel: HelpReplyChannel): string {
  const t = HELP_CASE_REPLIES[lang];
  return channel === 'web' ? t.where_web : channel === 'telegram' ? t.where_telegram : t.where_whatsapp;
}

/**
 * The fixed case-opened reply: the opening line with the case number, then the
 * channel's where-line. The case id is made by our code; it is still flattened
 * and bounded, so it can never add a line.
 */
export function helpCaseReply(
  kind: HelpCaseReplyKind,
  lang: HelpReplyLang,
  opts: { caseId: string; channel: HelpReplyChannel },
): string {
  const caseId = boundUntrustedText(opts.caseId, CASE_ID_MAX).replace(/\s+/g, '');
  return `${HELP_CASE_REPLIES[lang][kind].replace('{case}', caseId)} ${helpWhereLine(lang, opts.channel)}`;
}
