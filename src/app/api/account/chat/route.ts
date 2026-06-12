import { NextRequest, NextResponse } from 'next/server';
import { getCurrentCustomer } from '@/lib/customer-auth';
import { checkIpRateLimit, enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { getRedis } from '@/lib/redis';
import { runWebChatTurn } from '@/lib/web-chat';
import { logError, logWarn } from '@/lib/log';

// /api/account/chat — the customer dashboard AI assistant (B5).
//
// SELF-GATED: the middleware matcher covers /account/** pages, NOT /api/** —
// this route authenticates every request itself via the __Host- session cookie
// (getCurrentCustomer), exactly like a server action self-gates. Throttles:
//   • per-IP fixed window (outer ring, fail-open like every limiter),
//   • per-customer daily turn cap (the shared fixed-window counter over a
//     24h window — an LLM-cost cap with a friendly refusal, also fail-open),
//   • per-phone in-flight lock: web turns are read-modify-write on the
//     conversation thread, so two tabs sending at once would clobber each
//     other's history — one turn at a time per customer (fail-open too).
// The turn itself runs the web-channel agent: tools narrowed to the
// WEB_TOOL_ALLOWLIST at both the schema and dispatch layers (tools.ts).

export const maxDuration = 60;

const MAX_MESSAGE_CHARS = 1000;
const DAILY_TURN_CAP = 100;

async function underDailyCap(phone: string): Promise<boolean> {
  try {
    // Reuse the shared fixed-window counter keyed by phone instead of IP.
    const r = await checkIpRateLimit(getRedis(), 'webchat-turns', phone, {
      limit: DAILY_TURN_CAP,
      windowSec: 86400,
    });
    return r.allowed;
  } catch (err) {
    logWarn('account.chat', 'daily-cap check failed — allowing turn', { err: String(err) });
    return true; // fail-open — the per-IP limiter is the outer ring
  }
}

export async function POST(req: NextRequest) {
  const limited = await enforceIpRateLimit(req, 'acctchat', 30);
  if (limited) return limited;

  const customer = await getCurrentCustomer();
  if (!customer) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > MAX_MESSAGE_CHARS
  ) {
    return NextResponse.json(
      { error: `Message must be 1-${MAX_MESSAGE_CHARS} characters.` },
      { status: 400 },
    );
  }

  if (!(await underDailyCap(customer.senderPhone))) {
    return NextResponse.json(
      {
        error:
          "You've reached today's chat limit. It resets tomorrow — or message us on WhatsApp anytime.",
      },
      { status: 429 },
    );
  }

  // One in-flight turn per customer: the conversation save is last-writer-wins,
  // so a concurrent second turn (another tab/device) would erase this one.
  // SET NX with a TTL bounds a crashed holder; lock failures fail open.
  const lockKey = `webchat:lock:${customer.senderPhone}`;
  let locked = false;
  try {
    locked = (await getRedis().set(lockKey, '1', { nx: true, ex: 90 })) !== null;
    if (!locked) {
      return NextResponse.json(
        { error: 'One message at a time, please — wait for the current reply to finish.' },
        { status: 429 },
      );
    }
  } catch {
    // fail-open: a limiter/lock outage must never kill the chat
  }

  try {
    const reply = await runWebChatTurn(customer, message.trim());
    return NextResponse.json({ reply });
  } catch (err) {
    // runWebChatTurn already degrades internal failures to a friendly line;
    // anything that still throws is logged (scrubbed) and answered generically.
    logError('account.chat', err);
    return NextResponse.json(
      { error: 'Something went wrong — please try again.' },
      { status: 500 },
    );
  } finally {
    if (locked) {
      try {
        await getRedis().del(lockKey);
      } catch {
        // the 90s TTL is the backstop
      }
    }
  }
}
