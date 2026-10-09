import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  askPhonePayload,
  buttonsPayload,
  parseTelegramUpdate,
  telegramConfigured,
  telegramTextForAgent,
  telegramWebhookUrl,
  tgSendText,
  tgSetWebhook,
  urlButtonPayload,
  connectTelegramWebhook,
  telegramErrorText,
  TelegramApiError,
} from '@/lib/telegram';

// Telegram test channel (2026-10-08): the pure update reader, the Bot API
// payloads, and the client's error contract (the token never leaves the URL).

const TOKEN = '123456789:AAtest-token_value';
const chat = { id: 4242, type: 'private' };
const from = { id: 4242, is_bot: false, first_name: 'V' };
const msg = (extra: Record<string, unknown>) => ({ update_id: 10, message: { message_id: 1, date: 1_700_000_000, chat, from, ...extra } });

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN);
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'test-secret');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('parseTelegramUpdate', () => {
  it('reads a private text message', () => {
    expect(parseTelegramUpdate(msg({ text: 'send 100 to mom' }))).toEqual({
      kind: 'text', updateId: 10, chatId: '4242', fromId: '4242', ref: 'm1', text: 'send 100 to mom', sentAtMs: 1_700_000_000_000,
    });
  });

  it('reads a shared contact with its user id', () => {
    expect(parseTelegramUpdate(msg({ contact: { phone_number: '+1 555 123 0000', first_name: 'V', user_id: 4242 } }))).toEqual({
      kind: 'contact', updateId: 10, chatId: '4242', fromId: '4242', ref: 'm1', phone: '+1 555 123 0000', contactUserId: '4242',
    });
  });

  it('a contact without user_id has contactUserId null', () => {
    const u = parseTelegramUpdate(msg({ contact: { phone_number: '15551230000', first_name: 'X' } }));
    expect(u).toMatchObject({ kind: 'contact', contactUserId: null });
  });

  it('reads a button tap from a private chat', () => {
    const body = { update_id: 11, callback_query: { id: 'cb1', from, data: 'approve:abcd1234', message: { message_id: 2, chat } } };
    expect(parseTelegramUpdate(body)).toEqual({ kind: 'button', updateId: 11, chatId: '4242', fromId: '4242', ref: 'ccb1', data: 'approve:abcd1234', callbackId: 'cb1' });
  });

  it('maps media to the unsupported kinds the bot already answers', () => {
    expect(parseTelegramUpdate(msg({ voice: { file_id: 'x', duration: 3 } }))).toMatchObject({ kind: 'unsupported', mediaType: 'audio' });
    expect(parseTelegramUpdate(msg({ photo: [{ file_id: 'x' }] }))).toMatchObject({ kind: 'unsupported', mediaType: 'image' });
    expect(parseTelegramUpdate(msg({ location: { latitude: 1, longitude: 2 } }))).toMatchObject({ kind: 'unsupported', mediaType: 'location' });
  });

  it('ignores groups, channels, edits and junk', () => {
    expect(parseTelegramUpdate({ update_id: 1, message: { chat: { id: -5, type: 'group' }, from, text: 'hi' } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, edited_message: { chat, from, text: 'hi' } })).toBeNull();
    expect(parseTelegramUpdate({ message: { chat, from, text: 'hi' } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, message: { chat, from, text: 'no message_id' } })).toBeNull();
    expect(parseTelegramUpdate('nope')).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
  });
});

describe('payloads', () => {
  it('/start (with a deep-link payload) reads as a greeting; other text is unchanged', () => {
    expect(telegramTextForAgent('/start')).toBe('Hi');
    expect(telegramTextForAgent('/start REF-TANA01')).toBe('Hi');
    expect(telegramTextForAgent('/startup')).toBe('/startup');
    expect(telegramTextForAgent('send 100')).toBe('send 100');
  });

  it('buttons are one per row and return the WhatsApp button id', () => {
    expect(buttonsPayload('1', 'Pick', [{ id: 'approve:abc', title: 'Approve & pay' }, { id: 'cancel:abc', title: 'Cancel' }])).toEqual({
      chat_id: '1',
      text: 'Pick',
      reply_markup: { inline_keyboard: [[{ text: 'Approve & pay', callback_data: 'approve:abc' }], [{ text: 'Cancel', callback_data: 'cancel:abc' }]] },
    });
  });

  it('a button id over 64 bytes is refused (Telegram would reject it)', () => {
    expect(() => buttonsPayload('1', 'x', [{ id: 'a'.repeat(65), title: 'x' }])).toThrow(/64 bytes/);
  });

  it('a link button needs https', () => {
    expect(urlButtonPayload('1', 'Pay', 'Pay now', 'https://smartremit.ai/pay/x')).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: 'Pay now', url: 'https://smartremit.ai/pay/x' }]] },
    });
    expect(() => urlButtonPayload('1', 'Pay', 'Pay now', 'http://x')).toThrow();
  });

  it('the phone prompt is a one-time contact keyboard', () => {
    expect(askPhonePayload('7')).toMatchObject({
      method: 'sendMessage',
      chat_id: '7',
      reply_markup: { keyboard: [[{ text: 'Share my phone number', request_contact: true }]], one_time_keyboard: true },
    });
  });
});

describe('config and client', () => {
  it('configured needs the token and a secret Telegram accepts', () => {
    expect(telegramConfigured()).toBe(true);
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'has space');
    expect(telegramConfigured()).toBe(false);
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'ok');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    expect(telegramConfigured()).toBe(false);
  });

  it('sendMessage posts to the Bot API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await tgSendText('4242', 'hello');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '4242', text: 'hello' });
  });

  it('a refused call throws without the token or the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })));
    const err = await tgSendText('4242', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).errorCode).toBe(403);
    expect(String((err as Error).message)).not.toContain('AAtest');
    expect(String((err as Error).message)).not.toContain('api.telegram.org');
  });

  it('a network error keeps the error name only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }));
    const err = (await tgSendText('1', 'x').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('AAtest');
    expect(err.message).toContain('TypeError');
  });

  it('setWebhook sends the secret and only message + callback_query updates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await tgSetWebhook('https://smartremit.ai/api/telegram');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://smartremit.ai/api/telegram',
      secret_token: 'test-secret',
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('the webhook URL is /api/telegram on the base URL', () => {
    expect(telegramWebhookUrl('https://smartremit.ai/')).toBe('https://smartremit.ai/api/telegram');
  });
});

// Production 2026-10-09: setWebhook answered 429 "retry after 1" to a single
// press, twice, 9 minutes apart. The button now waits out a short retry_after.
describe('connect webhook', () => {
  const URL_ = 'https://smartremit.ai/api/telegram';
  const tooMany = () => new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }), { status: 429 });
  const ok = (result: unknown = true) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const methods = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map(([u]) => String(u).split('/').pop());

  afterEach(() => vi.useRealTimers());

  it('a 429 with a short retry_after is waited out and tried again', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const p = connectTelegramWebhook(URL_);
    await vi.advanceTimersByTimeAsync(1250);
    await expect(p).resolves.toEqual({ result: 'ok' });
    expect(methods(fetchMock)).toEqual(['setWebhook', 'setWebhook']);
  });

  it('the retry_after is read into the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => tooMany()));
    const err = (await tgSendText('1', 'x').catch((e: unknown) => e)) as TelegramApiError;
    expect(err.errorCode).toBe(429);
    expect(err.retryAfter).toBe(1);
  });

  it('three 429s: Telegram already sends to this URL, so it reports already', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(ok({ url: URL_, pending_update_count: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = connectTelegramWebhook(URL_);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ result: 'already' });
    expect(methods(fetchMock)).toEqual(['setWebhook', 'setWebhook', 'setWebhook', 'getWebhookInfo']);
  });

  it('a refused token is an error with its code, and no retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(connectTelegramWebhook(URL_)).resolves.toMatchObject({ result: 'error', code: 401 });
    expect(methods(fetchMock)).toEqual(['setWebhook', 'getWebhookInfo']);
  });

  it('a long retry_after is not waited out in the request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429, description: 'x', parameters: { retry_after: 30 } }), { status: 429 }))
      .mockResolvedValueOnce(ok({ url: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(connectTelegramWebhook(URL_)).resolves.toMatchObject({ result: 'error', code: 429 });
    expect(methods(fetchMock)).toEqual(['setWebhook', 'getWebhookInfo']);
  });

  it('not configured: unset, no call', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(connectTelegramWebhook(URL_)).resolves.toEqual({ result: 'unset' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the page message names the token only for 401 and 404', () => {
    expect(telegramErrorText('401')).toMatch(/does not accept the bot token/);
    expect(telegramErrorText('404')).toMatch(/does not accept the bot token/);
    expect(telegramErrorText('429')).toMatch(/busy/);
    expect(telegramErrorText('429')).not.toMatch(/token/);
    expect(telegramErrorText(undefined)).toBe('Telegram refused the webhook. Wait one minute, then press the button once. The server log has the reason.');
    expect(telegramErrorText('<script>')).not.toContain('<script>');
  });
});

