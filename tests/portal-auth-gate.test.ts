import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-5, Task 5.5: the portal customer gate, the 15-minute step-up and sign-out.
// Isolation (Review Focus 1): a session cookie minted on partner A's host is "signed out" on B's;
// a step-up started in one session cannot finish in another; a legacy cookie is never accepted.

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
    ip: '203.0.113.1',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    jar: new Map<string, string>(),
    cookieSets: [] as Array<{ name: string; value: string; opts: Record<string, unknown> | undefined }>,
    afterQ: [] as Array<() => Promise<void>>,
    runAfterInline: false,
    redis: null as unknown as Record<string, (...a: unknown[]) => unknown>,
    ops: [] as string[],
    failPotp: false,
    db: null as unknown,
    ready: { ready: true, creds: { phoneNumberId: '555000', token: 'tok' }, template: { name: 'acme_login', lang: 'en' } } as Record<string, unknown>,
    sends: [] as Array<{ partnerId: string; phone: string; code: string }>,
    sendHang: false,
    mfaEnrolled: new Set<string>(),
    mfaValid: '654321',
    redisProxy: null as unknown,
  };
  state.redisProxy = new Proxy(
    {},
    {
      get: (_t, k: string) =>
        (...a: unknown[]) => {
          state.ops.push(`${k} ${String(a[0])}`);
          if (state.failPotp && String(a[0]).startsWith('potp:')) throw new Error('redis down');
          return state.redis[k](...a);
        },
    },
  );
  return state;
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai', 'x-forwarded-for': h.ip, 'user-agent': h.ua }),
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      h.cookieSets.push({ name: n, value: v, opts: o });
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => h.jar.delete(n),
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => {
    h.afterQ.push(cb);
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
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));
vi.mock('@/lib/portal-otp-sender', async (orig) => ({
  ...(await orig<typeof import('@/lib/portal-otp-sender')>()),
  portalOtpChannelReady: async () => h.ready,
  sendPortalOtp: async (partnerId: string, phone: string, code: string) => {
    h.sends.push({ partnerId, phone, code });
    if (h.sendHang) return new Promise(() => {});
    return { ok: true };
  },
}));
vi.mock('@/lib/customer-mfa', () => ({
  getCustomerMfaStore: () => ({
    isEnrolled: async (k: { partnerId: string; phone: string }) => h.mfaEnrolled.has(`${k.partnerId}|${k.phone}`),
    verifyCode: async (_k: unknown, c: string) => c === h.mfaValid,
  }),
}));


import { getPortalCustomer, requireFreshPortalAuth, requirePortalCustomer, safePortalNext } from '@/lib/portal-auth';
import { stepUpRequestAction, stepUpTotpAction, stepUpVerifyAction, type PortalStepUpState } from '@/app/portal/verify/actions';
import { signOutAction } from '@/app/portal/signout/actions';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { createCustomerRepo } from '@/db/repos/customer-repo';

const PHONE = TWO_PARTNER_PHONE;
let db: Db;
let redis: FakeRedis;
let now = Date.now();

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function flushAfter() {
  while (h.afterQ.length) await h.afterQ.shift()!();
}
const lastCode = () => h.sends.at(-1)?.code;
const sessions = () => createPortalSessionStore(redis, { now: () => now });
async function expectRedirect(p: Promise<unknown>, to: string) {
  await expect(p).rejects.toThrow(`REDIRECT:${to}`);
}
async function signedIn(partnerId: string): Promise<string> {
  const { token } = await sessions().create(partnerId, PHONE, 'Safari on iOS');
  h.jar.set(PORTAL_SESSION_COOKIE, token);
  return token;
}
async function auditCount(partnerId: string, action: string) {
  return (await db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, action)))).length;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.site = SITE('pa', 'acme');
  h.jar = new Map();
  h.cookieSets = [];
  h.afterQ = [];
  h.ops = [];
  h.sends = [];
  h.mfaEnrolled = new Set();
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const repo = createCustomerRepo(db, async () => null);
  await repo.upsertOnFirstInbound('pa', PHONE);
  await repo.upsertOnFirstInbound('pb', PHONE);
});

describe('requirePortalCustomer', () => {
  it('1. no cookie → redirect to /portal/login', async () => {
    await expectRedirect(requirePortalCustomer(), '/portal/login');
  });
  it("2. A's cookie on B's host → redirect (the cookie-replay DoD item)", async () => {
    await signedIn('pa');
    expect((await requirePortalCustomer()).site.partnerId).toBe('pa');
    h.site = SITE('pb', 'bravo');
    await expectRedirect(requirePortalCustomer(), '/portal/login');
  });
  it('3. a legacy __Host-sr_session cookie alone is never accepted', async () => {
    h.jar.set(CUSTOMER_SESSION_COOKIE, 'a'.repeat(64));
    await expectRedirect(requirePortalCustomer(), '/portal/login');
  });
  it('a forged / malformed portal cookie → redirect', async () => {
    h.jar.set(PORTAL_SESSION_COOKIE, 'deadbeef');
    await expectRedirect(requirePortalCustomer(), '/portal/login');
  });
  it('a live session whose customer row is gone → null', async () => {
    const { token } = await sessions().create('pa', '14155559999', 'Safari on iOS');
    h.jar.set(PORTAL_SESSION_COOKIE, token);
    expect(await getPortalCustomer()).toBeNull();
  });
  it('apex → 404 before any cookie or store read', async () => {
    h.site = null;
    await expect(requirePortalCustomer()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(h.ops).toEqual([]);
  });
});

describe('requireFreshPortalAuth', () => {
  it('4. a session older than 15 minutes → /portal/verify?next=/portal/send; a fresh one passes', async () => {
    await signedIn('pa');
    expect((await requireFreshPortalAuth('/portal/send')).session.phone).toBe(PHONE);
    now += 16 * 60_000;
    await expectRedirect(requireFreshPortalAuth('/portal/send'), '/portal/verify?next=/portal/send');
  });
  it('an unsafe returnTo falls back to /portal in the redirect', async () => {
    await signedIn('pa');
    now += 16 * 60_000;
    await expectRedirect(requireFreshPortalAuth('//evil.com'), '/portal/verify?next=/portal');
  });
  it('a TOTP-enrolled customer is not fresh on a WhatsApp code alone', async () => {
    h.mfaEnrolled.add(`pa|${PHONE}`);
    await signedIn('pa'); // sign-in stamps authAtMs, never totpAtMs
    await expectRedirect(requireFreshPortalAuth('/portal/send'), '/portal/verify?next=/portal/send');
  });
});

describe('5. safePortalNext', () => {
  it.each(['//evil.com', '/admin-dashboard', '/portal/../admin-dashboard', '/portal/transfers/a b', '/portal/send?x=1',
    'https://evil.com/portal', '/portal/', '/portalx', '/portal/recipients/ABC/edit', '/portal/transfers/x', null, 42])(
    '%s → /portal',
    (v) => expect(safePortalNext(v)).toBe('/portal'),
  );
  it.each(['/portal', '/portal/send', '/portal/send/review', '/portal/transfers/tx_ABC123', `/portal/recipients/${'a'.repeat(32)}/edit`,
    '/portal/devices', '/portal/privacy'])('%s is kept', (v) => expect(safePortalNext(v)).toBe(v));
});

describe('step-up', () => {
  async function startStepUp(): Promise<PortalStepUpState> {
    const s = await stepUpRequestAction(null, fd({ next: '/portal/send', phone: '19999999999' }));
    expect(s.step).toBe('code');
    await flushAfter();
    return s;
  }

  it('the code goes to the SESSION phone (a phone field is ignored); verify → fresh → redirect to next', async () => {
    const token = await signedIn('pa');
    now += 16 * 60_000;
    const s = await startStepUp();
    expect(h.sends.map((x) => [x.partnerId, x.phone])).toEqual([['pa', PHONE]]);
    await expectRedirect(stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! })), '/portal/send');
    const sess = await sessions().resolve(token, 'pa');
    expect(sessions().isFresh(sess!)).toBe(true);
    expect(await auditCount('pa', 'portal.auth.stepup_success')).toBe(1);
  });

  it('an unsafe next is replaced by /portal', async () => {
    await signedIn('pa');
    const s = await stepUpRequestAction(null, fd({ next: '//evil.com' }));
    expect(s.next).toBe('/portal');
    await flushAfter();
    await expectRedirect(stepUpVerifyAction(null, fd({ next: 'https://evil.com', pending: s.pending!, code: lastCode()! })), '/portal');
  });

  it("6. a step-up started in A's session cannot be finished in B's (other host) or in another session", async () => {
    await signedIn('pa');
    const s = await startStepUp();
    // same partner, a DIFFERENT session of the same customer
    await signedIn('pa');
    expect(await stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! }))).toMatchObject({
      step: 'start',
      error: 'portal.login.expired',
    });
    // partner B's host with B's own session
    h.site = SITE('pb', 'bravo');
    await signedIn('pb');
    expect(await stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! }))).toMatchObject({
      step: 'start',
      error: 'portal.login.expired',
    });
  });

  it('a wrong code → one copy, audited; the step-up needs a session', async () => {
    await signedIn('pa');
    const s = await startStepUp();
    const bad = lastCode() === '000000' ? '000001' : '000000';
    expect(await stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: bad }))).toEqual({
      step: 'code',
      next: '/portal/send',
      pending: s.pending,
      error: 'portal.login.code_invalid',
    });
    await flushAfter();
    expect(await auditCount('pa', 'portal.auth.stepup_failure')).toBe(1);
    h.jar = new Map();
    await expectRedirect(stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! })), '/portal/login');
  });

  describe('7. a TOTP-enrolled customer', () => {
    beforeEach(() => h.mfaEnrolled.add(`pa|${PHONE}`));

    it('a correct WhatsApp code alone does NOT mark the session fresh; code + TOTP does', async () => {
      const token = await signedIn('pa');
      now += 16 * 60_000;
      const s = await startStepUp();
      const m = await stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! }));
      expect(m.step).toBe('mfa');
      let sess = await sessions().resolve(token, 'pa');
      expect(sessions().isFresh(sess!, { requireTotp: true })).toBe(false);
      expect(sessions().isFresh(sess!)).toBe(false); // authAtMs was not stamped either
      await expectRedirect(stepUpTotpAction(null, fd({ next: '/portal/send', pending: m.pending!, code: h.mfaValid })), '/portal/send');
      sess = await sessions().resolve(token, 'pa');
      expect(sessions().isFresh(sess!, { requireTotp: true })).toBe(true);
    });

    it('five wrong TOTP codes → back to the start of step-up', async () => {
      await signedIn('pa');
      const s = await startStepUp();
      const m = await stepUpVerifyAction(null, fd({ next: '/portal/send', pending: s.pending!, code: lastCode()! }));
      const out: PortalStepUpState[] = [];
      for (let i = 0; i < 5; i++) out.push(await stepUpTotpAction(null, fd({ next: '/portal/send', pending: m.pending!, code: '111111' })));
      expect(out.slice(0, 4).every((o) => o.step === 'mfa')).toBe(true);
      expect(out[4]).toEqual({ step: 'start', next: '/portal/send', error: 'portal.login.try_later' });
      expect(await stepUpTotpAction(null, fd({ next: '/portal/send', pending: m.pending!, code: h.mfaValid }))).toMatchObject({
        step: 'start',
        error: 'portal.login.expired',
      });
    });
  });

  it('channel not ready → cant_send, nothing issued', async () => {
    await signedIn('pa');
    h.ready = { ready: false, why: 'no_template' };
    expect(await stepUpRequestAction(null, fd({ next: '/portal/send' }))).toEqual({ step: 'start', next: '/portal/send', error: 'portal.login.cant_send' });
    await flushAfter();
    expect(h.sends).toEqual([]);
    h.ready = { ready: true, creds: { phoneNumberId: '555000', token: 'tok' }, template: { name: 'acme_login', lang: 'en' } };
  });
});

describe('signOutAction', () => {
  it('destroys the session, clears the cookie with its __Host- attributes, audits, redirects', async () => {
    const token = await signedIn('pa');
    await expectRedirect(signOutAction(), '/portal/login');
    expect(await sessions().resolve(token, 'pa')).toBeNull();
    const cleared = h.cookieSets.at(-1)!;
    expect(cleared).toEqual({ name: PORTAL_SESSION_COOKIE, value: '', opts: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 } });
    expect(await auditCount('pa', 'portal.auth.signout')).toBe(1);
  });
  it("on B's host, A's cookie is not a session there: A's session survives, the cookie is cleared", async () => {
    const token = await signedIn('pa');
    h.site = SITE('pb', 'bravo');
    await expectRedirect(signOutAction(), '/portal/login');
    expect(await sessions().resolve(token, 'pa')).not.toBeNull();
    expect(await auditCount('pb', 'portal.auth.signout')).toBe(0);
  });
  it('no cookie → still clears and redirects (idempotent)', async () => {
    await expectRedirect(signOutAction(), '/portal/login');
  });
});
