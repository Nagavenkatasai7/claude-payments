import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { PARTNER_ANY } from '@/lib/partner-access';
import { peekPartnerStaff } from '@/lib/partner-live-access';
import { liveNeeds, liveStamp, liveStampParts } from '@/lib/partner-live-stamp';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';
import { logWarn } from '@/lib/log';

export const dynamic = 'force-dynamic';

// GET /partner/live (lost-features A15): the polling target of the /partner live refresher. It
// answers ONLY an opaque stamp (sha256 of what the role may see moving), never a figure, so a
// support member cannot read money totals through it. Outside the (app) group: it is not a page.
//   - Auth: peekPartnerStaff (every partner role, MFA enforced, the session NOT refreshed). Any
//     refusal is 401 with an empty body, never a redirect (fetch would follow it).
//   - Cost: at most two indexed aggregates per call, cached 15 s per tenant and part in Redis, so
//     many open tabs of one tenant cost one Neon pair per 15 s. The cache key holds a hash of the
//     tenant id, never the id. A Redis error computes directly (fail-open: the data is the tenant's
//     own, and the session check above never depends on the cache).
const CACHE_SECONDS = 15;
const NO_STORE = { 'cache-control': 'no-store' };

const cacheKey = (partnerId: string, part: 'money' | 'tickets') =>
  `plive:${createHash('sha256').update(partnerId).digest('hex')}:${part}`;

async function cached(partnerId: string, part: 'money' | 'tickets', compute: () => Promise<string>): Promise<string> {
  const key = cacheKey(partnerId, part);
  try {
    const hit = await getRedis().get(key);
    if (typeof hit === 'string') return hit;
  } catch (err) {
    logWarn('partner.live', err instanceof Error ? err.name : 'error', { source: 'cache_read' });
  }
  const value = await compute();
  try {
    await getRedis().set(key, value, { ex: CACHE_SECONDS });
  } catch (err) {
    logWarn('partner.live', err instanceof Error ? err.name : 'error', { source: 'cache_write' });
  }
  return value;
}

async function moneyPart(partnerId: string): Promise<string> {
  const s = await getStore().transfersSummary(partnerId);
  return JSON.stringify([s.total, s.byStatus, s.needsAttention, s.latest]);
}

export async function GET(): Promise<Response> {
  const ctx = await peekPartnerStaff(PARTNER_ANY);
  if (!ctx) return NextResponse.json({}, { status: 401, headers: NO_STORE });
  const needs = liveNeeds(ctx.role);
  const [money, tickets] = await Promise.all([
    needs.money ? cached(ctx.partnerId, 'money', () => moneyPart(ctx.partnerId)) : undefined,
    needs.tickets ? cached(ctx.partnerId, 'tickets', () => createTicketRepo(getDb()).ticketStamp(ctx.partnerId)) : undefined,
  ]);
  const stamp = liveStamp(liveStampParts(ctx.role, { ...(money !== undefined ? { money } : {}), ...(tickets !== undefined ? { tickets } : {}) }));
  return NextResponse.json({ stamp }, { headers: NO_STORE });
}
