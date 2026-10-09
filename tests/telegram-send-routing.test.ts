import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { authenticationTemplateParams } from '@/lib/whatsapp-templates';

// Telegram test channel, outbound: a send to a phone whose last message came
// from Telegram goes to that chat, through the SAME WhatsApp send functions, so
// every reply, card, pay link, code and notice follows. Only the shared number;
// only with the switch on and Telegram configured; templates defer to the
// callers' text fallback. Phones are fakes.

const PHONE = '15551230000';
const CHAT = '4242';

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import {
  sendAuthTemplate,
  sendCtaUrl,
  sendInteractive,
  sendTemplate,
  sendTemplateOrText,
  sendText,
  TelegramNoTemplateError,
} from '@/lib/whatsapp';

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: {}, messages: [{ id: 'wamid.x' }] }), { status: 200 }));
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> }));
const telegramCalls = () => calls().filter((c) => c.url.startsWith('https://api.telegram.org/'));
const graphCalls = () => calls().filter((c) => c.url.startsWith('https://graph.facebook.com/'));

async function telegramSwitch(on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'telegram.bot', scopeType: 'global', scopeId: '', enabled: on, reason: 'telegram test bot', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  invalidateFlagCache(db);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:test');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'secret');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '999000');
  vi.stubEnv('WHATSAPP_TOKEN', 'wa-token');
  vi.stubEnv('DEMO_PHONES', '*');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await telegramSwitch(true);
  redis.dump.set(`tg:route:${PHONE}`, CHAT);
  redis.dump.set(`tg:chat:${CHAT}`, PHONE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routed to Telegram', () => {
  it('sendText goes to the chat, never to Meta', async () => {
    await sendText(PHONE, 'Your transfer is on its way.');
    expect(graphCalls()).toEqual([]);
    expect(telegramCalls()).toEqual([{ url: 'https://api.telegram.org/bot123:test/sendMessage', body: { chat_id: CHAT, text: 'Your transfer is on its way.' } }]);
  });

  it('a long text is split under the Telegram limit', async () => {
    await sendText(PHONE, `${'a'.repeat(3990)}\n${'b'.repeat(100)}`);
    expect(telegramCalls().map((c) => String(c.body.text).length)).toEqual([3990, 100]);
  });

  it('buttons become inline buttons that return the same ids', async () => {
    await sendInteractive(PHONE, 'Approve $100 to Mom?', [{ id: 'approve:abcd1234', title: 'Approve & pay' }, { id: 'cancel:abcd1234', title: 'Cancel' }]);
    expect(graphCalls()).toEqual([]);
    expect(telegramCalls()[0].body).toEqual({
      chat_id: CHAT,
      text: 'Approve $100 to Mom?',
      reply_markup: { inline_keyboard: [[{ text: 'Approve & pay', callback_data: 'approve:abcd1234' }], [{ text: 'Cancel', callback_data: 'cancel:abcd1234' }]] },
    });
  });

  it('a link card becomes a link button', async () => {
    await sendCtaUrl(PHONE, 'Pay for your transfer', { displayText: 'Pay now', url: 'https://smartremit.ai/pay/abc' }, 'SmartRemit');
    expect(telegramCalls()[0].body).toEqual({
      chat_id: CHAT,
      text: 'SmartRemit\n\nPay for your transfer',
      reply_markup: { inline_keyboard: [[{ text: 'Pay now', url: 'https://smartremit.ai/pay/abc' }]] },
    });
  });

  it('a template is not sent; sendTemplateOrText falls back to the text on Telegram', async () => {
    await expect(sendTemplate(PHONE, 'transfer_delivered_sender', 'en', ['x'])).rejects.toBeInstanceOf(TelegramNoTemplateError);
    const outcome = await sendTemplateOrText(PHONE, () => sendTemplate(PHONE, 'transfer_delivered_sender', 'en', ['x']), 'Delivered.');
    expect(outcome).toEqual({ ok: true, via: 'text' });
    expect(graphCalls()).toEqual([]);
    expect(telegramCalls().map((c) => c.body.text)).toEqual(['Delivered.']);
  });

  it('an authentication template sends the code as text', async () => {
    await sendAuthTemplate(PHONE, 'verification_code', 'en', authenticationTemplateParams('482913'));
    expect(graphCalls()).toEqual([]);
    expect(String(telegramCalls()[0].body.text)).toContain('482913');
  });
});

describe('stays on WhatsApp', () => {
  it('a phone with no route mark', async () => {
    redis.dump.clear();
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
  });

  it("a partner's own number (other creds), even with a route mark", async () => {
    await sendText(PHONE, 'hi', { phoneNumberId: '555111', token: 'partner-token' });
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()[0].url).toContain('/555111/messages');
  });

  it("the shared number's own creds still route", async () => {
    await sendText(PHONE, 'hi', { phoneNumberId: '999000', token: 'wa-token' });
    expect(graphCalls()).toEqual([]);
    expect(telegramCalls()).toHaveLength(1);
  });

  it('the switch off', async () => {
    await telegramSwitch(false);
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
  });

  it('Telegram not configured: no Redis read at all', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const get = vi.spyOn(redis, 'get');
    await sendText(PHONE, 'hi');
    expect(get).not.toHaveBeenCalled();
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
  });

  it('the chat link expired or names another phone', async () => {
    redis.dump.delete(`tg:chat:${CHAT}`);
    await sendText(PHONE, 'hi');
    redis.dump.set(`tg:chat:${CHAT}`, '15550000009');
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(2);
  });

  it('the phone left demo mode', async () => {
    vi.stubEnv('DEMO_PHONES', '15550000009');
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
  });

  it('the phone is also a customer of another partner (tenant rule)', async () => {
    await seedPartner(db, 'acme');
    await db.execute(sql`INSERT INTO customers (phone, partner_id, first_seen_at, sender_country) VALUES (${PHONE}, 'acme', now(), 'US')`);
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
  });

  it('a Redis error sends on WhatsApp', async () => {
    vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('redis down'));
    await sendText(PHONE, 'hi');
    expect(telegramCalls()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
  });
});
