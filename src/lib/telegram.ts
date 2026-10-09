import { env } from './env';
import { scrub } from './log';
import type { UnsupportedMediaType } from './types';

// telegram — the Telegram Bot API for the Telegram TEST channel (owner request
// 2026-10-08, plan https://claude.ai/artifact/XgFAa9oWsDvAbgqg47wJMF). Test and
// demo data only: Telegram is not a US-hosted vendor, so real customers wait for
// counsel. Only the shared SmartRemit bot (the default partner) uses it.
//
// Two halves, both small:
//  - parseTelegramUpdate: the pure reader for one webhook Update. Private chats
//    only; everything else reads as null (ignored).
//  - the Bot API calls (sendMessage, answerCallbackQuery, setWebhook). The token
//    is in the URL path, so an error NEVER carries the URL: only the method, the
//    error_code and a scrubbed, bounded description.
//
// Bot API reference: https://core.telegram.org/bots/api (setWebhook secret_token:
// 1-256 chars of A-Z a-z 0-9 _ -, sent back in X-Telegram-Bot-Api-Secret-Token;
// failed calls answer { ok: false, error_code, description }).

/** Telegram refuses a message text over 4,096 characters; callers split at this. */
export const TELEGRAM_TEXT_MAX = 4000;
/** Telegram's limit for an inline button's callback_data, in bytes. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_TIMEOUT_MS = 10_000;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** True when the bot token and a valid webhook secret are both set. */
export function telegramConfigured(): boolean {
  return env.telegramBotToken !== '' && SECRET_RE.test(env.telegramWebhookSecret);
}

/**
 * `ref` is the dedupe reference inside the chat: `m<message_id>` for a message
 * (unique and never reused in a private chat), `c<callback id>` for a button
 * tap. Not update_id: Telegram may restart update ids after a quiet week.
 */
type Base = { updateId: number; chatId: string; fromId: string; ref: string };
export type TelegramUpdate =
  | (Base & { kind: 'text'; text: string; sentAtMs?: number })
  | (Base & { kind: 'contact'; phone: string; contactUserId: string | null })
  | (Base & { kind: 'button'; data: string; callbackId: string })
  | (Base & { kind: 'unsupported'; mediaType: UnsupportedMediaType });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Telegram ids are integers of up to 52 bits; kept as decimal strings. */
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null);

const MEDIA_KINDS: ReadonlyArray<[string, UnsupportedMediaType]> = [
  ['voice', 'audio'],
  ['audio', 'audio'],
  ['photo', 'image'],
  ['video', 'video'],
  ['video_note', 'video'],
  ['animation', 'video'],
  ['document', 'document'],
  ['sticker', 'sticker'],
  ['location', 'location'],
  ['venue', 'location'],
];

/** One webhook Update → a TelegramUpdate, or null (not a private-chat message or button tap). Pure. */
export function parseTelegramUpdate(body: unknown): TelegramUpdate | null {
  if (!isObj(body) || typeof body.update_id !== 'number' || !Number.isSafeInteger(body.update_id)) return null;
  const updateId = body.update_id;

  const cb = body.callback_query;
  if (isObj(cb)) {
    const msg = cb.message;
    if (!isObj(msg) || !isObj(msg.chat) || msg.chat.type !== 'private') return null;
    const chatId = idOf(msg.chat.id);
    const fromId = isObj(cb.from) ? idOf(cb.from.id) : null;
    if (!chatId || !fromId || typeof cb.id !== 'string' || typeof cb.data !== 'string') return null;
    return { kind: 'button', updateId, chatId, fromId, ref: `c${cb.id}`, data: cb.data, callbackId: cb.id };
  }

  const msg = body.message;
  if (!isObj(msg) || !isObj(msg.chat) || msg.chat.type !== 'private') return null;
  const chatId = idOf(msg.chat.id);
  const fromId = isObj(msg.from) ? idOf(msg.from.id) : null;
  const messageRef = idOf(msg.message_id);
  if (!chatId || !fromId || !messageRef) return null;
  const ref = `m${messageRef}`;
  const sentAtMs = typeof msg.date === 'number' && Number.isFinite(msg.date) ? msg.date * 1000 : undefined;

  if (isObj(msg.contact) && typeof msg.contact.phone_number === 'string') {
    return { kind: 'contact', updateId, chatId, fromId, ref, phone: msg.contact.phone_number, contactUserId: idOf(msg.contact.user_id) };
  }
  if (typeof msg.text === 'string') {
    return { kind: 'text', updateId, chatId, fromId, ref, text: msg.text, ...(sentAtMs !== undefined ? { sentAtMs } : {}) };
  }
  if (isObj(msg.contact)) return { kind: 'unsupported', updateId, chatId, fromId, ref, mediaType: 'contacts' };
  const media = MEDIA_KINDS.find(([field]) => msg[field] !== undefined);
  return { kind: 'unsupported', updateId, chatId, fromId, ref, mediaType: media ? media[1] : 'document' };
}

/** "/start" (with or without a deep-link payload) opens the chat; the bot treats it as a greeting. */
export function telegramTextForAgent(text: string): string {
  return /^\/start(?:@\w+)?(?:\s|$)/i.test(text.trim()) ? 'Hi' : text;
}

export interface TelegramButton {
  id: string;
  title: string;
}

/** sendMessage body: plain text (no parse_mode, so the bot's text is shown as written). Pure. */
export function textPayload(chatId: string, text: string): Obj {
  return { chat_id: chatId, text };
}

/** sendMessage body with one inline button per row; each tap returns its id as callback_data. Pure. */
export function buttonsPayload(chatId: string, text: string, buttons: readonly TelegramButton[]): Obj {
  for (const b of buttons) {
    if (new TextEncoder().encode(b.id).length > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
      throw new Error('telegram: a button id is longer than 64 bytes');
    }
  }
  return {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.title, callback_data: b.id }]) },
  };
}

/** sendMessage body with one link button (opens the URL; no callback). Pure. */
export function urlButtonPayload(chatId: string, text: string, label: string, url: string): Obj {
  if (!url.startsWith('https://')) throw new Error('telegram: a link button needs an https:// URL');
  return { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: label, url }]] } };
}

export const SHARE_PHONE_LABEL = 'Share my phone number';
export const SHARE_PHONE_PROMPT =
  'Welcome to SmartRemit. To start, tap "Share my phone number" below. We use it to find your SmartRemit account. ' +
  'This Telegram bot is a test version.';
export const SHARE_OWN_PHONE_PROMPT = 'Please share your own phone number with the button below.';
export const PHONE_LINKED_REPLY = 'Thank you. Your number is linked. Now type your message, for example: Send $100 to Mom.';
export const NOT_AVAILABLE_REPLY = 'The SmartRemit Telegram bot is not available for this phone number yet. Please use WhatsApp.';

/** The webhook-answer form of sendMessage with the one-time "Share my phone number" keyboard. Pure. */
export function askPhonePayload(chatId: string, text: string = SHARE_PHONE_PROMPT): Obj {
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text,
    reply_markup: { keyboard: [[{ text: SHARE_PHONE_LABEL, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
  };
}

/** The webhook-answer form of sendMessage that also removes the reply keyboard. Pure. */
export function plainAnswerPayload(chatId: string, text: string): Obj {
  return { method: 'sendMessage', chat_id: chatId, text, reply_markup: { remove_keyboard: true } };
}

/** The webhook-answer form of answerCallbackQuery (stops the button's loading state). Pure. */
export function answerCallbackPayload(callbackId: string): Obj {
  return { method: 'answerCallbackQuery', callback_query_id: callbackId };
}

/** A failed Bot API call. The message never holds the URL (the token is in it). */
export class TelegramApiError extends Error {
  readonly errorCode: number | undefined;
  constructor(method: string, errorCode: number | undefined, description: string) {
    super(`Telegram ${method} failed (${errorCode ?? 'no code'}): ${scrub(description).slice(0, 200)}`);
    this.name = 'TelegramApiError';
    this.errorCode = errorCode;
  }
}

async function callBotApi(method: string, payload: Obj): Promise<unknown> {
  if (!env.telegramBotToken) throw new TelegramApiError(method, undefined, 'TELEGRAM_BOT_TOKEN is not set');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (err) {
    // A fetch error can name the URL; keep the error NAME only.
    throw new TelegramApiError(method, undefined, err instanceof Error ? err.name : 'network error');
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isObj(json) && json.ok === true) return json.result;
  const code = isObj(json) && typeof json.error_code === 'number' ? json.error_code : res.status;
  const description = isObj(json) && typeof json.description === 'string' ? json.description : 'no description';
  throw new TelegramApiError(method, code, description);
}

/** One plain text message. The caller splits a long body at TELEGRAM_TEXT_MAX. */
export async function tgSendText(chatId: string, text: string): Promise<void> {
  await callBotApi('sendMessage', textPayload(chatId, text));
}

export async function tgSendButtons(chatId: string, text: string, buttons: readonly TelegramButton[]): Promise<void> {
  await callBotApi('sendMessage', buttonsPayload(chatId, text, buttons));
}

export async function tgSendUrlButton(chatId: string, text: string, label: string, url: string): Promise<void> {
  await callBotApi('sendMessage', urlButtonPayload(chatId, text, label, url));
}

/** The webhook URL for this deployment. */
export function telegramWebhookUrl(baseUrl: string = env.appBaseUrl): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/telegram`;
}

/** Register this deployment's webhook with Telegram (admin button on /admin-dashboard/switches). */
export async function tgSetWebhook(url: string = telegramWebhookUrl()): Promise<void> {
  if (!SECRET_RE.test(env.telegramWebhookSecret)) {
    throw new TelegramApiError('setWebhook', undefined, 'TELEGRAM_WEBHOOK_SECRET is missing or has characters Telegram refuses');
  }
  await callBotApi('setWebhook', {
    url,
    secret_token: env.telegramWebhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
}
