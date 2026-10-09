import { and, eq, ne } from 'drizzle-orm';
import { getRedis } from './redis';
import { getDb } from '@/db/client';
import { customers } from '@/db/schema';
import { inDemo } from './demo-mode';
import { isFlagOn } from './flags';
import { env } from './env';
import { telegramConfigured } from './telegram';
import { DEFAULT_PARTNER_ID } from './defaults';
import { logWarn } from './log';

// telegram-link — the two Redis marks of the Telegram test channel (hot state,
// like sessions and chat history; nothing is written to Neon).
//
//   tg:chat:<chatId>  → phone   the chat's VERIFIED phone (the customer shared
//                               their own contact; telegram-inbound.ts checks it).
//                               A FIXED 14-day life, never extended: the customer
//                               shares the contact again after it, so a number
//                               that changed owner cannot stay linked to the old chat.
//   tg:route:<phone>  → chatId  "this customer wrote on Telegram last". Every
//                               send to the shared number reads it (whatsapp.ts),
//                               so replies, pay links, codes and notices follow.
//                               A WhatsApp message from the phone deletes it.
//
// The route refreshes on every Telegram message. Tenant rule: only a phone that is
// a customer of the default partner ONLY is linked or routed. A phone that is also
// a customer of any other partner never is, because the sends carry no tenant
// (an API-only partner sends from the shared number too). Every read fails toward
// WhatsApp: a Redis, database or flag error ⇒ no route.

export const TELEGRAM_LINK_TTL_SEC = 14 * 24 * 60 * 60;
export const TELEGRAM_ROUTE_TTL_SEC = 30 * 24 * 60 * 60;

const chatKey = (chatId: string) => `tg:chat:${chatId}`;
const routeKey = (phone: string) => `tg:route:${phone}`;

/** The verified phone linked to this chat, or null. */
export async function linkedPhone(chatId: string): Promise<string | null> {
  return (await getRedis().get(chatKey(chatId))) || null;
}

/** Link a chat to its verified phone (called only after the contact check). */
export async function linkChat(chatId: string, phone: string): Promise<void> {
  await getRedis().set(chatKey(chatId), phone, { ex: TELEGRAM_LINK_TTL_SEC });
}

/** Mark Telegram as this phone's last channel. The chat link keeps its own fixed expiry. */
export async function markTelegramRoute(phone: string, chatId: string): Promise<void> {
  await getRedis().set(routeKey(phone), chatId, { ex: TELEGRAM_ROUTE_TTL_SEC });
}

/** Is this phone a customer of any partner other than the default one? (Then Telegram is never used.) */
export async function hasPartnerCustomer(phone: string): Promise<boolean> {
  const found = await getDb()
    .select({ partnerId: customers.partnerId })
    .from(customers)
    .where(and(eq(customers.phone, phone), ne(customers.partnerId, DEFAULT_PARTNER_ID)))
    .limit(1);
  return found.length > 0;
}

/** A WhatsApp message makes WhatsApp the last channel again. No-op while Telegram is not configured. */
export async function clearTelegramRoute(phone: string): Promise<void> {
  if (!telegramConfigured()) return;
  await getRedis().del(routeKey(phone));
}

/** Is the `telegram.bot` switch on for the default partner? Fails closed. */
export function telegramSwitchOn(): Promise<boolean> {
  return isFlagOn(getDb(), 'telegram.bot', { partnerId: DEFAULT_PARTNER_ID });
}

/**
 * The Telegram chat a send to `to` must go to instead of WhatsApp, or null.
 * Only for the shared number: no creds, or the env number's own creds. Order
 * keeps the common case cheap: no Telegram config ⇒ no read at all; no route
 * mark ⇒ one Redis GET; the rest is read only for a marked phone: the chat
 * link must still name this phone, the phone must still be in demo mode and a
 * default-only customer, and the switch must be on.
 */
export async function telegramChatFor(to: string, credsPhoneNumberId?: string): Promise<string | null> {
  if (credsPhoneNumberId !== undefined && credsPhoneNumberId !== env.whatsappPhoneNumberId) return null;
  if (!telegramConfigured()) return null;
  try {
    const redis = getRedis();
    const chatId = await redis.get(routeKey(to));
    if (!chatId) return null;
    if ((await redis.get(chatKey(chatId))) !== to) return null;
    if (!inDemo(to)) return null;
    if (await hasPartnerCustomer(to)) return null;
    return (await telegramSwitchOn()) ? chatId : null;
  } catch (err) {
    logWarn('telegram.route', 'route read failed; sending on WhatsApp', { error: err instanceof Error ? err.name : 'error' });
    return null;
  }
}
