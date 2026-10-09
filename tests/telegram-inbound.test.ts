import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { createReferralRepo } from '@/db/repos/referral-repo';
import { NOT_AVAILABLE_REPLY, PHONE_LINKED_REPLY, SHARE_OWN_PHONE_PROMPT, SHARE_PHONE_PROMPT } from '@/lib/telegram';

// Telegram test channel, inbound: the switch, the own-contact phone check, the
// demo-mode gate, and a linked chat running the SAME pipeline as WhatsApp
// (one durable agent.turn keyed by the update id, channel 'tg'). Phones are fakes.

const PHONE = '15551230000';
const CHAT = 4242;

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
const { pokeWorker } = vi.hoisted(() => ({ pokeWorker: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ pokeWorker, pokeWorkerDelayed: vi.fn() }));

import { handleTelegramUpdate } from '@/lib/telegram-inbound';
import { processInboundWebhook } from '@/lib/whatsapp-inbound';

const chat = { id: CHAT, type: 'private' };
const from = { id: CHAT, is_bot: false, first_name: 'V' };
const msg = (updateId: number, extra: Record<string, unknown>) => ({ update_id: updateId, message: { message_id: updateId, date: 1_700_000_000, chat, from, ...extra } });
const contact = (updateId: number, userId: number | undefined, phone = `+${PHONE}`) =>
  msg(updateId, { contact: { phone_number: phone, first_name: 'V', ...(userId !== undefined ? { user_id: userId } : {}) } });
const tap = (updateId: number, data: string) => ({ update_id: updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: 1, chat } } });

async function rows(q: string): Promise<Record<string, unknown>[]> {
  return ((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;
}
const outboxRows = () => rows(`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`);

async function telegramSwitch(on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'telegram.bot', scopeType: 'global', scopeId: '', enabled: on, reason: 'telegram test bot', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

async function linkPhone() {
  expect(await handleTelegramUpdate(contact(1, CHAT))).toMatchObject({ method: 'sendMessage', text: PHONE_LINKED_REPLY });
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  invalidateFlagCache(db);
  pokeWorker.mockClear();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:test');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'secret');
  vi.stubEnv('DEMO_PHONES', '*');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await telegramSwitch(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('switch and linking', () => {
  it('switch off: every update is ignored and nothing is written', async () => {
    await telegramSwitch(false);
    expect(await handleTelegramUpdate(contact(1, CHAT))).toBeNull();
    expect(await handleTelegramUpdate(msg(2, { text: 'hi' }))).toBeNull();
    expect(redis.dump.size).toBe(0);
    expect(await outboxRows()).toEqual([]);
  });

  it('an unlinked chat is asked for its phone number; nothing is queued', async () => {
    expect(await handleTelegramUpdate(msg(2, { text: 'hi' }))).toMatchObject({ method: 'sendMessage', chat_id: String(CHAT), text: SHARE_PHONE_PROMPT });
    expect(await outboxRows()).toEqual([]);
  });

  it("someone else's contact (or one without user_id) never links", async () => {
    expect(await handleTelegramUpdate(contact(1, 999))).toMatchObject({ text: SHARE_OWN_PHONE_PROMPT });
    expect(await handleTelegramUpdate(contact(2, undefined))).toMatchObject({ text: SHARE_OWN_PHONE_PROMPT });
    expect(redis.dump.has(`tg:chat:${CHAT}`)).toBe(false);
  });

  it('the own contact links the chat to the digits-only phone', async () => {
    await linkPhone();
    expect(redis.dump.get(`tg:chat:${CHAT}`)).toBe(PHONE);
  });

  it('a phone outside demo mode is refused, at link time and later', async () => {
    vi.stubEnv('DEMO_PHONES', '15550000009');
    expect(await handleTelegramUpdate(contact(1, CHAT))).toMatchObject({ text: NOT_AVAILABLE_REPLY });
    expect(redis.dump.has(`tg:chat:${CHAT}`)).toBe(false);
    vi.stubEnv('DEMO_PHONES', '*');
    await linkPhone();
    vi.stubEnv('DEMO_PHONES', '15550000009');
    expect(await handleTelegramUpdate(msg(3, { text: 'hi' }))).toMatchObject({ text: NOT_AVAILABLE_REPLY });
    expect(await outboxRows()).toEqual([]);
  });
});

describe('tenant rule and link life', () => {
  it('a phone that is also a customer of another partner never links, and a later partner row stops a linked chat', async () => {
    await seedPartner(db, 'acme');
    await db.execute(sql`INSERT INTO customers (phone, partner_id, first_seen_at, sender_country) VALUES (${PHONE}, 'acme', now(), 'US')`);
    expect(await handleTelegramUpdate(contact(1, CHAT))).toMatchObject({ text: NOT_AVAILABLE_REPLY });
    expect(redis.dump.has(`tg:chat:${CHAT}`)).toBe(false);
    redis.dump.set(`tg:chat:${CHAT}`, PHONE); // linked before the partner row existed
    expect(await handleTelegramUpdate(msg(2, { text: 'hi' }))).toMatchObject({ text: NOT_AVAILABLE_REPLY });
    expect(await outboxRows()).toEqual([]);
  });

  it('messages never extend the chat link (fixed life)', async () => {
    await linkPhone();
    const expire = vi.spyOn(redis, 'expire');
    const set = vi.spyOn(redis, 'set');
    await handleTelegramUpdate(msg(3, { text: 'hi' }));
    expect(expire.mock.calls.some(([k]) => String(k).startsWith('tg:chat:'))).toBe(false);
    expect(set.mock.calls.some(([k]) => String(k).startsWith('tg:chat:'))).toBe(false);
  });
});

describe('a linked chat runs the WhatsApp pipeline', () => {
  it('a text becomes ONE agent.turn (channel tg) and Telegram becomes the reply channel', async () => {
    await linkPhone();
    expect(await handleTelegramUpdate(msg(5, { text: 'send 100 to mom' }))).toBeNull();
    expect(await outboxRows()).toEqual([
      {
        kind: 'agent.turn',
        dedupe_key: `wamid:tg:${CHAT}:m5`,
        payload: expect.objectContaining({
          phone: PHONE,
          messageText: 'send 100 to mom',
          routedPartnerId: null,
          channel: 'tg',
          turn: expect.objectContaining({ surface: 'telegram' }),
        }),
      },
    ]);
    expect(redis.dump.get(`tg:route:${PHONE}`)).toBe(String(CHAT));
    expect(pokeWorker).toHaveBeenCalled();
    const customers = await rows(`SELECT partner_id FROM customers WHERE phone = '${PHONE}'`);
    expect(customers).toEqual([{ partner_id: 'default' }]);
  });

  it('a redelivered update queues nothing new', async () => {
    await linkPhone();
    await handleTelegramUpdate(msg(6, { text: 'hi' }));
    for (const k of [...redis.dump.keys()]) if (k.startsWith('msgq')) redis.dump.delete(k); // the DB dedups
    await handleTelegramUpdate(msg(6, { text: 'hi' }));
    expect((await outboxRows()).filter((r) => r.kind === 'agent.turn')).toHaveLength(1);
  });

  it('/start reads as a greeting', async () => {
    await linkPhone();
    await handleTelegramUpdate(msg(7, { text: '/start' }));
    expect((await outboxRows())[0].payload).toMatchObject({ messageText: 'Hi' });
  });

  it('a button tap is the WhatsApp button turn, and the tap is answered', async () => {
    await linkPhone();
    expect(await handleTelegramUpdate(tap(8, 'recipient:new'))).toEqual({ method: 'answerCallbackQuery', callback_query_id: 'cb8' });
    expect((await outboxRows())[0].payload).toMatchObject({ messageText: '[Tapped: Someone new]', turn: expect.objectContaining({ buttonTap: { kind: 'recipient_new' } }) });
  });

  it('a voice note gets the "please type" reply, never a voice turn', async () => {
    await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType: 'global', scopeId: '', enabled: true, reason: 'voice beta test', updatedBy: 'admin' });
    invalidateFlagCache(db);
    vi.stubEnv('AZURE_SPEECH_KEY', 'k');
    vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
    await linkPhone();
    await handleTelegramUpdate(msg(9, { voice: { file_id: 'x', duration: 2 } }));
    const out = await outboxRows();
    expect(out.map((r) => r.kind)).toEqual(['whatsapp.text']);
    expect(out[0].payload).toMatchObject({ to: PHONE, category: 'essential' });
  });

  it('a referral code in a Telegram text is not recorded (WhatsApp and portal only)', async () => {
    const repo = createReferralRepo(db);
    await repo.insertPartner({ id: 'rp_tana', name: 'TANA', contact: 'events@tana.org', commissionCents: 100, createdBy: 'admin' });
    await repo.insertCode({ code: 'REF-TANA01', referralPartnerId: 'rp_tana', createdBy: 'admin' });
    await linkPhone();
    await handleTelegramUpdate(msg(10, { text: 'REF-TANA01' }));
    expect(await rows(`SELECT phone FROM referral_attributions`)).toEqual([]);
  });

  it('a WhatsApp message from the phone makes WhatsApp the reply channel again', async () => {
    await linkPhone();
    await handleTelegramUpdate(msg(11, { text: 'hi' }));
    expect(redis.dump.has(`tg:route:${PHONE}`)).toBe(true);
    const webhook = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: PHONE, id: 'wamid.W1', type: 'text', text: { body: 'hi' } }] } }] }] };
    await processInboundWebhook(webhook, { routedPartnerId: null });
    expect(redis.dump.has(`tg:route:${PHONE}`)).toBe(false);
  });
});
