import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { telegramConfigured } from '@/lib/telegram';
import { handleTelegramUpdate } from '@/lib/telegram-inbound';
import { isInfraError } from '@/lib/infra-error';
import { logWarn } from '@/lib/log';

// The Telegram test channel's webhook (2026-10-08). Registered by the
// "Connect Telegram webhook" button on /admin-dashboard/switches with
// secret_token = TELEGRAM_WEBHOOK_SECRET; Telegram sends that secret back in
// X-Telegram-Bot-Api-Secret-Token on every call (https://core.telegram.org/bots/api#setwebhook).
//
// Gate ABOVE any side effect, fail closed: Telegram not configured ⇒ 404;
// a missing or wrong secret ⇒ 401. Then telegram-inbound.ts does the work.
// Answers: 200 (empty, or ONE Bot API method in the body); 500 only for an
// infrastructure error, so Telegram redelivers and the `wamid:tg:<chat>:<ref>`
// unique key keeps the retry exactly-once. Anything else is acknowledged (200)
// so one bad update never blocks the chat's queue.

function secretMatches(got: string | null): boolean {
  const want = Buffer.from(env.telegramWebhookSecret);
  const have = Buffer.from(got ?? '');
  return have.length === want.length && timingSafeEqual(have, want);
}

export async function POST(req: NextRequest) {
  if (!telegramConfigured()) return NextResponse.json({ ok: false }, { status: 404 });
  if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token'))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  try {
    const answer = await handleTelegramUpdate(body);
    return NextResponse.json(answer ?? { ok: true });
  } catch (err) {
    if (isInfraError(err)) {
      logWarn('telegram.inbound', 'infrastructure error; Telegram will redeliver', { error: err instanceof Error ? err.name : 'error' });
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    logWarn('telegram.inbound', 'update not processed; acknowledged', { error: err instanceof Error ? err.name : 'error' });
    return NextResponse.json({ ok: true });
  }
}
