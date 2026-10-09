import { normalizePhone, isValidPhone } from './phone';
import { inDemo } from './demo-mode';
import { logWarn } from './log';
import { processTelegramMessage } from './whatsapp-inbound';
import { hasPartnerCustomer, linkChat, linkedPhone, markTelegramRoute, telegramSwitchOn } from './telegram-link';
import {
  answerCallbackPayload,
  askPhonePayload,
  NOT_AVAILABLE_REPLY,
  parseTelegramUpdate,
  PHONE_LINKED_REPLY,
  plainAnswerPayload,
  SHARE_OWN_PHONE_PROMPT,
  telegramTextForAgent,
  type TelegramUpdate,
} from './telegram';
import type { IncomingMessage } from './types';

// telegram-inbound — one Telegram webhook Update, AFTER the route's secret
// check. Returns the webhook answer: null (empty 200) or ONE Bot API method in
// the response body (Telegram runs it; its result is not known, which is fine
// for these prompts: the customer can always send again).
//
// Order:
//  1. switch off (or unreadable) ⇒ ignore the update.
//  2. a shared contact ⇒ accept it ONLY when it is the sender's own contact
//     (contact.user_id === from.id: Telegram gives the account's verified
//     number). A typed or forwarded number never links. The phone must also be
//     a demo-mode phone (DEMO_PHONES) and must not be a customer of any partner
//     other than the default one (the tenant rule, telegram-link.ts).
//  3. no linked phone ⇒ ask for it ("Share my phone number" keyboard).
//  4. linked ⇒ mark Telegram as the reply channel and run the SAME inbound
//     pipeline as WhatsApp (processTelegramMessage) under the default tenant.
// No phone, text or chat id is ever logged.

export type TelegramAnswer = Record<string, unknown> | null;

function toIncoming(u: Exclude<TelegramUpdate, { kind: 'contact' }>, phone: string): IncomingMessage {
  const messageId = `tg:${u.chatId}:${u.ref}`;
  if (u.kind === 'text') {
    return {
      kind: 'text',
      from: phone,
      text: telegramTextForAgent(u.text),
      messageId,
      ...(u.sentAtMs !== undefined ? { sentAtMs: u.sentAtMs } : {}),
    };
  }
  if (u.kind === 'button') return { kind: 'button', from: phone, buttonId: u.data, messageId };
  return { kind: 'unsupported', from: phone, mediaType: u.mediaType, messageId };
}

export async function handleTelegramUpdate(body: unknown): Promise<TelegramAnswer> {
  const u = parseTelegramUpdate(body);
  if (!u) return null;
  if (!(await telegramSwitchOn())) return null;

  if (u.kind === 'contact') {
    if (u.contactUserId === null || u.contactUserId !== u.fromId) return askPhonePayload(u.chatId, SHARE_OWN_PHONE_PROMPT);
    const phone = normalizePhone(u.phone);
    if (!isValidPhone(phone)) return askPhonePayload(u.chatId, SHARE_OWN_PHONE_PROMPT);
    if (!inDemo(phone) || (await hasPartnerCustomer(phone))) {
      logWarn('telegram.link', 'contact refused: not a demo-mode phone, or a customer of another partner');
      return plainAnswerPayload(u.chatId, NOT_AVAILABLE_REPLY);
    }
    await linkChat(u.chatId, phone);
    return plainAnswerPayload(u.chatId, PHONE_LINKED_REPLY);
  }

  const phone = await linkedPhone(u.chatId);
  if (!phone) {
    return u.kind === 'button' ? answerCallbackPayload(u.callbackId) : askPhonePayload(u.chatId);
  }
  // DEMO_PHONES can shrink and partner rows can appear after a link: both checks run on every message.
  if (!inDemo(phone) || (await hasPartnerCustomer(phone))) return plainAnswerPayload(u.chatId, NOT_AVAILABLE_REPLY);

  // Before the pipeline, so its reply-only branches (STOP, throttle, media)
  // already route to this chat. A convergent SET: a redelivery repeats it.
  await markTelegramRoute(phone, u.chatId);
  await processTelegramMessage(toIncoming(u, phone));
  return u.kind === 'button' ? answerCallbackPayload(u.callbackId) : null;
}
