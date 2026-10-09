import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Telegram test channel webhook: the secret gate runs before any work, fails
// closed, and an infrastructure error is a 500 so Telegram redelivers.

const { handleTelegramUpdate } = vi.hoisted(() => ({ handleTelegramUpdate: vi.fn(async (_b: unknown): Promise<Record<string, unknown> | null> => null) }));
vi.mock('@/lib/telegram-inbound', () => ({ handleTelegramUpdate }));

import { POST } from '@/app/api/telegram/route';

const SECRET = 'test-secret';
const req = (body: unknown, secret?: string) =>
  new NextRequest('https://smartremit.ai/api/telegram', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(secret !== undefined ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
  });

beforeEach(() => {
  handleTelegramUpdate.mockReset();
  handleTelegramUpdate.mockResolvedValue(null);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:test');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/telegram', () => {
  it('404 while Telegram is not configured', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    expect((await POST(req({ update_id: 1 }, SECRET))).status).toBe(404);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it('401 for a missing or wrong secret, before any work', async () => {
    expect((await POST(req({ update_id: 1 }))).status).toBe(401);
    expect((await POST(req({ update_id: 1 }, 'test-secret-x'))).status).toBe(401);
    expect((await POST(req({ update_id: 1 }, 'short'))).status).toBe(401);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it('a valid call answers with the Bot API method the handler returns', async () => {
    handleTelegramUpdate.mockResolvedValueOnce({ method: 'answerCallbackQuery', callback_query_id: 'cb1' });
    const res = await POST(req({ update_id: 1 }, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'answerCallbackQuery', callback_query_id: 'cb1' });
    expect(handleTelegramUpdate).toHaveBeenCalledWith({ update_id: 1 });
  });

  it('a body that is not JSON is acknowledged', async () => {
    const res = await POST(req('not json', SECRET));
    expect(res.status).toBe(200);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it('an infrastructure error is a 500 (Telegram redelivers); any other error is acknowledged', async () => {
    handleTelegramUpdate.mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), { name: 'DatabaseError' }));
    expect((await POST(req({ update_id: 1 }, SECRET))).status).toBe(500);
    handleTelegramUpdate.mockRejectedValueOnce(new TypeError('bad input'));
    expect((await POST(req({ update_id: 2 }, SECRET))).status).toBe(200);
  });
});
