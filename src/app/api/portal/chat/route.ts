import { NextResponse, type NextRequest } from 'next/server';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalCustomer, isPortalSessionFresh } from '@/lib/portal-auth';
import { isSameOrigin } from '@/lib/same-origin';
import { checkIpRateLimit, enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { getRedis } from '@/lib/redis';
import { runWebChatTurn } from '@/lib/web-chat';
import {
  PORTAL_CHAT_DAILY_CAP,
  PORTAL_CHAT_IP_LIMIT,
  PORTAL_CHAT_LOCK_TTL_S,
  PORTAL_CHAT_MAX_BODY_BYTES,
  PORTAL_CHAT_MAX_MESSAGE_CHARS,
  PORTAL_CHAT_TURNS_SCOPE,
  portalChatLockKey,
  portalChatSubject,
  readCappedText,
} from '@/lib/portal-chat';
import { logError, logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';

// POST /api/portal/chat — the customer portal's chat (UI redesign M2-12, Task 12.3). A route handler
// gets NO Next Origin check (unlike a server action), so it self-gates, in this order:
//  1. requirePortalSite(): apex, portal off or partner not enabled → notFound(), which a route handler
//     turns into a bodyless 404 (node_modules/next/dist/server/route-modules/app-route/module.js:493-497);
//  2. the per-IP limit (fail-open, the outer ring);
//  3. isSameOrigin (fail-closed on a missing Origin) → 403, BEFORE any session read;
//  4. the portal session bound to THIS host's partner → 401 (another partner's cookie is signed out);
//  5. the body: at most PORTAL_CHAT_MAX_BODY_BYTES read (413), JSON, a 1-1000 character message (400);
//  6. the daily cap and 7. the in-flight lock, both keyed by (partner, customer), never the phone alone;
//  8. the EXISTING web-chat turn (src/lib/web-chat.ts: channel 'web', WEB_TOOL_ALLOWLIST at the schema
//     and dispatch layers, the tenant-keyed web thread) for the session's own (partner, phone) row,
//     carrying the session's step-up freshness (isPortalSessionFresh) so cancel / refund / recall
//     refuse on a stale session exactly where the transfer page would ask for the fresh proof.
// No new agent logic and no money path: money still moves only through the pay page.

export const maxDuration = 60;

const fail = (status: number, key: MessageKey) => NextResponse.json({ error: t(key) }, { status });

async function underDailyCap(subject: string): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(getRedis(), PORTAL_CHAT_TURNS_SCOPE, subject, { limit: PORTAL_CHAT_DAILY_CAP, windowSec: 86_400 });
    return r.allowed;
  } catch (err) {
    logWarn('portal.chat', 'daily-cap check failed, allowing the turn', { err: String(err) });
    return true; // fail-open: the per-IP limiter is the outer ring (legacy parity)
  }
}

export async function POST(req: NextRequest) {
  await requirePortalSite();

  const limited = await enforceIpRateLimit(req, 'portalchat', PORTAL_CHAT_IP_LIMIT);
  if (limited) return limited;

  if (!isSameOrigin(req.headers)) return fail(403, 'portal.chat.error.generic');

  const ctx = await getPortalCustomer();
  if (!ctx) return fail(401, 'portal.chat.error.signed_out');
  const { partnerId } = ctx.site;
  const phone = ctx.session.phone;

  const raw = await readCappedText(req.body, PORTAL_CHAT_MAX_BODY_BYTES).catch(() => '');
  if (raw === null) return fail(413, 'portal.chat.error.too_large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'portal.chat.error.invalid');
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || message.trim().length === 0 || message.length > PORTAL_CHAT_MAX_MESSAGE_CHARS) {
    return fail(400, 'portal.chat.error.invalid');
  }

  if (!(await underDailyCap(portalChatSubject(partnerId, phone)))) return fail(429, 'portal.chat.error.daily_cap');

  // One in-flight turn per (partner, customer): the web thread save is last-writer-wins, so a second
  // concurrent turn (another tab) would erase this one. SET NX with a TTL; a lock outage fails open.
  const lockKey = portalChatLockKey(partnerId, phone);
  let locked = false;
  try {
    locked = (await getRedis().set(lockKey, '1', { nx: true, ex: PORTAL_CHAT_LOCK_TTL_S })) !== null;
    if (!locked) return fail(429, 'portal.chat.error.one_at_a_time');
  } catch {
    // fail-open: a limiter/lock outage must never kill the chat
  }

  try {
    // ctx.customer is the (host partner, session phone) row: getPortalCustomer reads it tenant-keyed.
    // The transfer page's 15-minute step-up rule, answered without a redirect (fail-closed): a stale
    // session still chats, but the money tools (cancel, refund, recall) refuse and point to the page.
    const fresh = await isPortalSessionFresh(ctx);
    const reply = await runWebChatTurn(ctx.customer, message.trim(), { webStepUp: { surface: 'portal', fresh } });
    return NextResponse.json({ reply });
  } catch (err) {
    logError('portal.chat', err);
    return fail(500, 'portal.chat.error.generic');
  } finally {
    if (locked) {
      try {
        await getRedis().del(lockKey);
      } catch {
        // the TTL is the backstop
      }
    }
  }
}
