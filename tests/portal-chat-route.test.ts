import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners } from './helpers-portal-two-partner';

// UI redesign M2-12, Task 12.3: POST /api/portal/chat. A route handler gets no Next Origin check, so
// it self-gates in this order: host gate (apex → the neutral 404) → per-IP limit → same-origin
// (else 403, before ANY session read) → the host-bound portal session (else 401) → the body cap and
// checks → the daily cap and the in-flight lock, both keyed by (partner, customer) → the existing
// web-chat turn (web channel, WEB_TOOL_ALLOWLIST) for the session's own tenant row.

const SITE = (partnerId: string, slug: string) => ({
  partnerId,
  slug,
  brand: `Brand ${slug}`,
  logo: null,
  theme: { primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false },
});

const h = vi.hoisted(() => {
  const state = {
    site: null as null | Record<string, unknown>,
    jar: new Map<string, string>(),
    cookieReads: 0,
    redis: null as unknown as Record<string, (...a: unknown[]) => unknown>,
    redisProxy: null as unknown,
    db: null as unknown,
    ipCalls: [] as Array<{ scope: string; limit: number }>,
    ipLimited: false,
    turns: [] as Array<{ partnerId: string; phone: string; text: string }>,
    turnImpl: null as null | (() => Promise<string>),
  };
  state.redisProxy = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => state.redis[k](...a) });
  return state;
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (n: string) => {
      h.cookieReads++;
      return h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redisProxy }));
vi.mock('@/db/client', () => ({ getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async () => {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  return { getCustomerStore: () => createCustomerRepo(h.db as never, async () => null) };
});
vi.mock('@/lib/ip-rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/ip-rate-limit')>()),
  enforceIpRateLimit: async (_req: unknown, scope: string, limit: number) => {
    h.ipCalls.push({ scope, limit });
    return h.ipLimited ? NextResponse.json({ ok: false }, { status: 429 }) : null;
  },
}));
vi.mock('@/lib/web-chat', () => ({
  runWebChatTurn: async (customer: { partnerId: string; senderPhone: string }, text: string) => {
    h.turns.push({ partnerId: customer.partnerId, phone: customer.senderPhone, text });
    return h.turnImpl ? h.turnImpl() : `reply for ${customer.partnerId}`;
  },
}));

import { POST } from '@/app/api/portal/chat/route';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { PORTAL_CHAT_DAILY_CAP, PORTAL_CHAT_MAX_BODY_BYTES, portalChatLockKey } from '@/lib/portal-chat';

let db: Db;
let redis: FakeRedis;
let phone: string;

const HOST = { pa: 'acme.smartremit.ai', pb: 'bravo.smartremit.ai' } as const;

function req(opts: { host?: string; origin?: string | null; body?: string; json?: unknown } = {}) {
  const host = opts.host ?? HOST.pa;
  const headers = new Headers({ host, 'content-type': 'application/json' });
  const origin = opts.origin === undefined ? `https://${host}` : opts.origin;
  if (origin !== null) headers.set('origin', origin);
  const body = opts.body ?? JSON.stringify(opts.json ?? { message: 'Where is my transfer?' });
  return new NextRequest(`https://${host}/api/portal/chat`, { method: 'POST', headers, body });
}
async function signIn(partnerId: 'pa' | 'pb') {
  const { token } = await createPortalSessionStore(redis).create(partnerId, phone, 'Safari on iOS');
  h.jar.set(PORTAL_SESSION_COOKIE, token);
}
function onHost(partnerId: 'pa' | 'pb') {
  h.site = SITE(partnerId, partnerId === 'pa' ? 'acme' : 'bravo');
}

beforeEach(async () => {
  db = await freshDb();
  ({ phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.jar = new Map();
  h.cookieReads = 0;
  h.ipCalls = [];
  h.ipLimited = false;
  h.turns = [];
  h.turnImpl = null;
  onHost('pa');
});

describe('POST /api/portal/chat: gates', () => {
  it('apex (no portal site) → the neutral 404 before the limiter, any cookie read or any turn', async () => {
    h.site = null;
    await expect(POST(req({ host: 'smartremit.ai' }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(h.ipCalls).toEqual([]);
    expect(h.cookieReads).toBe(0);
    expect(h.turns).toEqual([]);
  });

  it('runs the per-IP limit (portalchat, 30/min) and returns its 429', async () => {
    await signIn('pa');
    h.ipLimited = true;
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(h.ipCalls).toEqual([{ scope: 'portalchat', limit: 30 }]);
    expect(h.turns).toEqual([]);
  });

  it('a missing Origin → 403 before any session read', async () => {
    await signIn('pa');
    const res = await POST(req({ origin: null }));
    expect(res.status).toBe(403);
    expect(h.cookieReads).toBe(0);
    expect(h.turns).toEqual([]);
  });

  it("a foreign Origin (another partner's subdomain, the apex, null) → 403 before any session read", async () => {
    await signIn('pa');
    for (const origin of [`https://${HOST.pb}`, 'https://smartremit.ai', 'null', 'https://evil.example']) {
      const res = await POST(req({ origin }));
      expect(res.status, origin).toBe(403);
    }
    expect(h.cookieReads).toBe(0);
    expect(h.turns).toEqual([]);
  });

  it('no portal session → 401', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.turns).toEqual([]);
  });

  it("A's session on B's host → 401 (the session is bound to the host partner)", async () => {
    await signIn('pa');
    onHost('pb');
    const res = await POST(req({ host: HOST.pb }));
    expect(res.status).toBe(401);
    expect(h.turns).toEqual([]);
  });
});

describe('POST /api/portal/chat: body', () => {
  it('a body over the byte cap → 413, never parsed', async () => {
    await signIn('pa');
    const big = JSON.stringify({ message: 'x'.repeat(PORTAL_CHAT_MAX_BODY_BYTES) });
    const res = await POST(req({ body: big }));
    expect(res.status).toBe(413);
    expect(h.turns).toEqual([]);
  });

  it('invalid JSON, a missing / blank / non-string / too-long message → 400', async () => {
    await signIn('pa');
    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ message: '   ' }), JSON.stringify({ message: 5 }), JSON.stringify({ message: 'x'.repeat(1001) })]) {
      const res = await POST(req({ body }));
      expect(res.status, body.slice(0, 20)).toBe(400);
    }
    expect(h.turns).toEqual([]);
  });
});

describe('POST /api/portal/chat: the turn', () => {
  it("runs the existing web-chat turn for the SESSION's tenant row (host partner + session phone), text trimmed", async () => {
    await signIn('pa');
    const res = await POST(req({ json: { message: '  Hello  ', partnerId: 'pb', phone: '14155550000' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'reply for pa' });
    expect(h.turns).toEqual([{ partnerId: 'pa', phone, text: 'Hello' }]);
  });

  it('the same phone on B runs under B (separate tenant thread)', async () => {
    onHost('pb');
    await signIn('pb');
    const res = await POST(req({ host: HOST.pb }));
    expect(res.status).toBe(200);
    expect(h.turns).toEqual([{ partnerId: 'pb', phone, text: 'Where is my transfer?' }]);
  });

  it('a turn that throws → a generic 500 and the lock is released', async () => {
    await signIn('pa');
    h.turnImpl = async () => {
      throw new Error('model down');
    };
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('model down');
    expect(await redis.get(portalChatLockKey('pa', phone))).toBeNull();
  });
});

describe('POST /api/portal/chat: caps are keyed by (partner, customer)', () => {
  it("A exhausting the daily cap leaves B free for the same phone", async () => {
    await signIn('pa');
    for (let i = 0; i < PORTAL_CHAT_DAILY_CAP; i++) expect((await POST(req())).status).toBe(200);
    const capped = await POST(req());
    expect(capped.status).toBe(429);
    onHost('pb');
    await signIn('pb');
    expect((await POST(req({ host: HOST.pb }))).status).toBe(200);
  });

  it("A's in-flight lock blocks a second A turn but never B's; it is released after the turn", async () => {
    await signIn('pa');
    await redis.set(portalChatLockKey('pa', phone), '1', { nx: true, ex: 90 });
    const blocked = await POST(req());
    expect(blocked.status).toBe(429);
    expect(h.turns).toEqual([]);

    onHost('pb');
    await signIn('pb');
    expect((await POST(req({ host: HOST.pb }))).status).toBe(200);
    expect(await redis.get(portalChatLockKey('pb', phone))).toBeNull();
  });

  it('the lock and cap keys carry the partner and never the raw phone', () => {
    const a = portalChatLockKey('pa', phone);
    expect(a).not.toContain(phone);
    expect(a).toContain('pa|');
    expect(a).not.toBe(portalChatLockKey('pb', phone));
  });
});

describe('CSP', () => {
  it("connect-src 'self' covers the same-origin /api/portal/chat (no new origin)", async () => {
    const { buildCsp } = await import('@/lib/csp');
    expect(buildCsp({ isDev: false })).toMatch(/(^|;\s*)connect-src 'self'(;|$)/);
  });
});
