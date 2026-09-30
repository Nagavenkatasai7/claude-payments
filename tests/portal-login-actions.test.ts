import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, customers, outbox } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-5, Task 5.4: the customer-portal sign-in actions. The binding rules under test:
// enumeration safety (identical responses + an identical request-path Redis sequence for every
// phone), everything phone-dependent inside after(), tenant from the HOST only, one copy for every
// failed code, register-by-verify under the host partner behind the O11 consent step, TOTP, rotation,
// the cookie attributes, the per-IP limits and 404 on the apex.

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
    /** M2-14: every Redis call on a key with this prefix throws. */
    failPrefix: '' as string,
    db: null as unknown,
    ready: { ready: true, creds: { phoneNumberId: '555000', token: 'tok' }, template: { name: 'acme_login', lang: 'en' } } as Record<string, unknown>,
    sends: [] as Array<{ partnerId: string; phone: string; code: string }>,
    sendHang: false,
    mfaEnrolled: new Set<string>(),
    mfaValid: '654321',
    redisProxy: null as unknown,
    inWindow: new Set<string>(),
    windowReads: [] as string[],
  };
  state.redisProxy = new Proxy(
    {},
    {
      get: (_t, k: string) =>
        (...a: unknown[]) => {
          state.ops.push(`${k} ${String(a[0])}`);
          if (state.failPotp && String(a[0]).startsWith('potp:')) throw new Error('redis down');
          if (state.failPrefix && String(a[0]).startsWith(state.failPrefix)) throw new Error('redis down');
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
vi.mock('@/lib/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/store')>()),
  // The 24h service-window marker (freeform mode only): in window iff the phone is in h.inWindow.
  getStore: () => ({
    getLastInboundAt: async (_pid: string, phone: string) => {
      h.windowReads.push(phone);
      return h.inWindow.has(phone) ? new Date().toISOString() : null;
    },
  }),
}));
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

import { consentAction, requestCodeAction, resendCodeAction, verifyCodeAction, verifyMfaAction, type PortalLoginState } from '@/app/portal/login/actions';
import { createPortalOtpStore, PORTAL_OTP_IP_LIMIT } from '@/lib/portal-otp-store';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { createCustomerRepo } from '@/db/repos/customer-repo';

const KNOWN = '14155550101';
const UNKNOWN = '14155560101';
const COOLDOWN = '14155570101';
const LOCKED = '14155580101';

let db: Db;
let redis: FakeRedis;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function flushAfter() {
  while (h.afterQ.length) await h.afterQ.shift()!();
}
const sendsTo = (phone: string) => h.sends.filter((s) => s.phone === phone);
const lastCode = (phone: string) => sendsTo(phone).at(-1)?.code;
const strip = (s: PortalLoginState) => ({ ...s, pending: undefined });
const repo = () => createCustomerRepo(db, async () => null);
const otp = () => createPortalOtpStore(redis);
const sessions = () => createPortalSessionStore(redis);
async function auditCount(partnerId: string, action: string) {
  return (await db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, action)))).length;
}
async function expectRedirect(p: Promise<unknown>, to: string) {
  await expect(p).rejects.toThrow(`REDIRECT:${to}`);
}

/** Request + flush + verify with the delivered code. Returns the verify state (or throws the redirect). */
async function codeStep(phone: string): Promise<{ pending: string; verify: () => Promise<PortalLoginState> }> {
  const s = await requestCodeAction(null, fd({ phone }));
  expect(s.step).toBe('code');
  await flushAfter();
  const code = lastCode(phone);
  expect(code).toMatch(/^\d{6}$/);
  return { pending: s.pending!, verify: () => verifyCodeAction(null, fd({ pending: s.pending!, code: code! })) };
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.site = SITE('pa', 'acme');
  h.ip = '203.0.113.1';
  h.jar = new Map();
  h.cookieSets = [];
  h.afterQ = [];
  h.ops = [];
  h.failPotp = false;
  h.failPrefix = '';
  h.sends = [];
  h.sendHang = false;
  h.inWindow = new Set();
  h.windowReads = [];
  h.mfaEnrolled = new Set();
  h.ready = { ready: true, creds: { phoneNumberId: '555000', token: 'tok' }, template: { name: 'acme_login', lang: 'en' } };
  await repo().upsertOnFirstInbound('pa', KNOWN); // a known, opted-in customer of pa
});

describe('requestCodeAction: enumeration safety', () => {
  it('1. known / unknown / cooldown / locked → the identical state; only known + unknown get a code', async () => {
    // cooldown: a code was just issued; locked: 5 wrong verifies
    expect((await otp().issue('pa', COOLDOWN, 'login')).ok).toBe(true);
    await otp().issue('pa', LOCKED, 'login');
    for (let i = 0; i < 5; i++) await otp().verify('pa', LOCKED, '000000', 'login');
    expect(await otp().isLocked('pa', LOCKED)).toBe(true);

    const states: PortalLoginState[] = [];
    for (const phone of [KNOWN, UNKNOWN, COOLDOWN, LOCKED]) states.push(await requestCodeAction(null, fd({ phone })));
    for (const s of states) {
      expect(strip(s)).toEqual({ step: 'code', last4: '0101', notice: 'portal.login.code_sent_if_possible', pending: undefined });
      expect(s.pending).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(h.sends).toEqual([]); // nothing phone-dependent ran yet
    await flushAfter();
    expect(h.sends.map((s) => s.phone).sort()).toEqual([KNOWN, UNKNOWN].sort());
    expect(h.sends.every((s) => s.partnerId === 'pa')).toBe(true);
    expect(JSON.stringify(states)).not.toContain(lastCode(KNOWN)!);
  });

  it('the response never carries the code or the full phone', async () => {
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    const json = JSON.stringify(s);
    expect(json).not.toContain(lastCode(KNOWN)!);
    expect(json).not.toContain(KNOWN);
  });

  it('a malformed number is the only phone-specific error (before any lookup or pending write)', async () => {
    h.ops = [];
    expect(await requestCodeAction(null, fd({ phone: '12' }))).toEqual({ step: 'phone', error: 'portal.login.phone_invalid' });
    expect(h.ops.filter((o) => !o.includes('iprl|'))).toEqual([]);
    expect(h.afterQ).toHaveLength(0);
  });

  it('an unsupported country gets the same code-step answer and no code', async () => {
    const s = await requestCodeAction(null, fd({ phone: '5511987654321' })); // Brazil: not in the allow-list
    expect(strip(s)).toEqual({ step: 'code', last4: '4321', notice: 'portal.login.code_sent_if_possible', pending: undefined });
    await flushAfter();
    expect(h.sends).toEqual([]);
  });

  it('2. the action never awaits the send (a hanging WhatsApp call cannot shape the response)', async () => {
    h.sendHang = true;
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    expect(s.step).toBe('code');
    expect(h.afterQ).toHaveLength(1);
    void h.afterQ.shift()!(); // starts, and never settles
  });

  it('3. channel not ready → cant_send for ANY phone; the audit and ONE ops.alert are written after the response', async () => {
    h.ready = { ready: false, why: 'channel_shared' };
    const a = await requestCodeAction(null, fd({ phone: KNOWN }));
    const b = await requestCodeAction(null, fd({ phone: UNKNOWN }));
    expect(a).toEqual({ step: 'phone', error: 'portal.login.cant_send' });
    expect(b).toEqual(a);
    expect(await db.select().from(outbox)).toHaveLength(0);
    await flushAfter();
    expect(await db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'))).toHaveLength(1);
    expect(await auditCount('pa', 'portal.auth.otp_send_failed')).toBe(2);
    expect(h.sends).toEqual([]);
  });

  it('3b. partner ceiling reached: a known customer still gets a code, an unknown phone none; identical answers', async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    await redis.set(`potp:p:pa:${hour}`, '300');
    const a = await requestCodeAction(null, fd({ phone: KNOWN }));
    const b = await requestCodeAction(null, fd({ phone: UNKNOWN }));
    expect(strip(a)).toEqual(strip(b));
    await flushAfter();
    expect(sendsTo(KNOWN)).toHaveLength(1);
    expect(sendsTo(UNKNOWN)).toHaveLength(0);
    expect(await auditCount('pa', 'portal.auth.otp_refused')).toBe(1);
  });

  it('12. per-IP 20/h: the 21st request sends nothing and answers identically', async () => {
    const win = Math.floor(Date.now() / (PORTAL_OTP_IP_LIMIT.windowSec * 1000));
    await redis.set(`iprl|${PORTAL_OTP_IP_LIMIT.scope}|${h.ip}|${win}`, '20');
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    expect(strip(s)).toEqual({ step: 'code', last4: '0101', notice: 'portal.login.code_sent_if_possible', pending: undefined });
    await flushAfter();
    expect(h.sends).toEqual([]);
    expect(await auditCount('pa', 'portal.auth.otp_refused')).toBe(1);
  });

  it('14. request-path purity: locked / cooldown / fresh phones make the identical Redis call sequence, no potp:* call', async () => {
    await otp().issue('pa', COOLDOWN, 'login');
    await otp().issue('pa', LOCKED, 'login');
    for (let i = 0; i < 5; i++) await otp().verify('pa', LOCKED, '000000', 'login');
    const seqs: string[][] = [];
    let n = 0;
    for (const phone of [LOCKED, COOLDOWN, UNKNOWN, KNOWN]) {
      h.ip = `198.51.100.${++n}`; // a fresh IP each time: checkIpRateLimit's EXPIRE runs on count 1 only
      h.ops = [];
      await requestCodeAction(null, fd({ phone }));
      expect(h.ops.some((o) => o.split(' ')[1].startsWith('potp:')), phone).toBe(false);
      seqs.push(h.ops.map((o) => o.split(' ')[0]));
    }
    expect(seqs[0].length).toBeGreaterThan(0);
    for (const s of seqs) expect(s).toEqual(seqs[0]);
    expect(h.afterQ).toHaveLength(4); // the phone-dependent work was queued, not run
  });

  it('11. apex (no portal site) → every action 404s before any store call', async () => {
    h.site = null;
    h.ops = [];
    for (const act of [requestCodeAction, resendCodeAction, verifyCodeAction, verifyMfaAction, consentAction]) {
      await expect(act(null, fd({ phone: KNOWN, pending: 'a'.repeat(64), code: '123456', consent: 'yes' }))).rejects.toThrow(
        'NEXT_HTTP_ERROR_FALLBACK;404',
      );
    }
    expect(h.ops).toEqual([]);
    expect(h.afterQ).toEqual([]);
  });
});

// Owner decision 2026-09-29: SmartRemit's own tenant has no approved AUTHENTICATION template yet,
// so its codes go as free-form chat text, only inside the 24h window. The window is phone-dependent,
// so it is read ONLY inside after(); the request path answers one chat notice for every phone.
describe('requestCodeAction: freeform mode (the default tenant without a template)', () => {
  const IN_WIN = KNOWN;
  const OUT_WIN = UNKNOWN;
  const CHAT_NOTICE = 'portal.login.code_sent_if_possible_chat';
  beforeEach(async () => {
    h.site = SITE('default', 'smartremit');
    h.ready = { ready: true, mode: 'freeform', creds: undefined };
    await repo().upsertOnFirstInbound('default', KNOWN);
    h.inWindow = new Set([IN_WIN]);
  });

  it('every phone (in / out of the window, known / unknown) gets the SAME chat notice; no window read on the request path', async () => {
    const states: PortalLoginState[] = [];
    for (const phone of [IN_WIN, OUT_WIN]) states.push(await requestCodeAction(null, fd({ phone })));
    for (const s of states) expect(strip(s)).toEqual({ step: 'code', last4: '0101', notice: CHAT_NOTICE, pending: undefined });
    expect(h.windowReads).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('request-path purity in freeform mode: the identical Redis call sequence in and out of the window', async () => {
    const seqs: string[][] = [];
    let n = 0;
    for (const phone of [IN_WIN, OUT_WIN]) {
      h.ip = `198.51.100.${++n}`;
      h.ops = [];
      await requestCodeAction(null, fd({ phone }));
      expect(h.ops.some((o) => o.split(' ')[1].startsWith('potp:') || o.split(' ')[1].startsWith('lastmsg:')), phone).toBe(false);
      seqs.push(h.ops.map((o) => o.split(' ')[0]));
    }
    expect(seqs[1]).toEqual(seqs[0]);
  });

  it('after the response: in window → sent; outside → no code issued, audited outside_window, NO ops alert', async () => {
    await requestCodeAction(null, fd({ phone: IN_WIN }));
    await requestCodeAction(null, fd({ phone: OUT_WIN }));
    await flushAfter();
    expect(h.sends.map((s) => [s.partnerId, s.phone])).toEqual([['default', IN_WIN]]);
    expect(await auditCount('default', 'portal.auth.otp_sent')).toBe(1);
    expect(await auditCount('default', 'portal.auth.otp_send_failed')).toBe(1);
    expect(await db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'))).toHaveLength(0);
    // Nothing was issued for the out-of-window phone, so no cooldown was claimed: after the customer
    // messages us, an immediate new request gets a code.
    h.inWindow.add(OUT_WIN);
    await requestCodeAction(null, fd({ phone: OUT_WIN }));
    await flushAfter();
    expect(sendsTo(OUT_WIN)).toHaveLength(1);
  });

  it('resend in freeform mode answers the same chat notice', async () => {
    const s = await requestCodeAction(null, fd({ phone: IN_WIN }));
    const r = await resendCodeAction(null, fd({ pending: s.pending! }));
    expect(r).toMatchObject({ step: 'code', last4: '0101', notice: CHAT_NOTICE });
  });

  it('template mode keeps the original notice', async () => {
    h.ready = { ready: true, mode: 'template', creds: undefined, template: { name: 'sr_login', lang: 'en' } };
    expect((await requestCodeAction(null, fd({ phone: OUT_WIN }))).notice).toBe('portal.login.code_sent_if_possible');
  });
});

describe('verifyCodeAction', () => {
  it('known, opted-in customer + the right code → session, cookie, audit, redirect /portal', async () => {
    const { verify } = await codeStep(KNOWN);
    await expectRedirect(verify(), '/portal');
    const token = h.jar.get(PORTAL_SESSION_COOKIE)!;
    const s = await sessions().resolve(token, 'pa');
    expect(s?.phone).toBe(KNOWN);
    expect(await auditCount('pa', 'portal.auth.login_success')).toBe(1);
    expect((await repo().getCustomer('pa', KNOWN))?.phoneVerifiedAt).toBeTruthy();
  });

  it('10. the cookie attributes: httpOnly, secure, lax, path /, 30 days, no domain', async () => {
    const { verify } = await codeStep(KNOWN);
    await expectRedirect(verify(), '/portal');
    const set = h.cookieSets.find((c) => c.name === PORTAL_SESSION_COOKIE && c.value !== '');
    expect(set?.opts).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2_592_000 });
  });

  it('4. register-by-verify (with O11 consent): unknown phone → consent step → row under the HOST partner, opted in, verified', async () => {
    const { verify } = await codeStep(UNKNOWN);
    const s = await verify();
    expect(s.step).toBe('consent');
    expect(await repo().getCustomer('pa', UNKNOWN)).toBeNull(); // nothing written before full authentication
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
    expect(await consentAction(null, fd({ pending: s.pending! }))).toEqual({
      step: 'consent',
      pending: s.pending,
      error: 'portal.login.consent_required',
    });
    await expectRedirect(consentAction(null, fd({ pending: s.pending!, consent: 'yes' })), '/portal');
    const row = (await db.select().from(customers).where(and(eq(customers.partnerId, 'pa'), eq(customers.phone, UNKNOWN))))[0];
    expect(row.optInAt).toBeTruthy();
    expect(row.phoneVerifiedAt).toBeTruthy();
    expect(await repo().getCustomer('pb', UNKNOWN)).toBeNull();
    expect(await auditCount('pa', 'portal.auth.register')).toBe(1);
    expect(await auditCount('pa', 'portal.auth.consent')).toBe(1);
    expect(await auditCount('pa', 'portal.auth.login_success')).toBe(1);
    // the consent token is single-use
    expect(await consentAction(null, fd({ pending: s.pending!, consent: 'yes' }))).toEqual({ step: 'phone', error: 'portal.login.expired' });
  });

  it('a double-submitted consent is single-use: one session, one register row, one consent row', async () => {
    const { verify } = await codeStep(UNKNOWN);
    const s = await verify();
    const results = await Promise.allSettled([
      consentAction(null, fd({ pending: s.pending!, consent: 'yes' })),
      consentAction(null, fd({ pending: s.pending!, consent: 'yes' })),
    ]);
    const redirects = results.filter((r) => r.status === 'rejected' && String((r.reason as Error).message) === 'REDIRECT:/portal');
    expect(redirects).toHaveLength(1);
    const other = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<PortalLoginState>;
    expect(other.value).toEqual({ step: 'phone', error: 'portal.login.expired' });
    expect(await sessions().list('pa', UNKNOWN)).toHaveLength(1);
    expect(await auditCount('pa', 'portal.auth.register')).toBe(1);
    expect(await auditCount('pa', 'portal.auth.consent')).toBe(1);
  });

  it('an existing row WITHOUT a WhatsApp opt-in (e.g. created by the partner API) also passes the consent step', async () => {
    await repo().ensureCustomer('pa', UNKNOWN);
    const { verify } = await codeStep(UNKNOWN);
    const s = await verify();
    expect(s.step).toBe('consent');
    await expectRedirect(consentAction(null, fd({ pending: s.pending!, consent: 'yes' })), '/portal');
    expect(await auditCount('pa', 'portal.auth.register')).toBe(0);
    expect((await repo().getCustomer('pa', UNKNOWN))?.optInAt).toBeTruthy();
  });

  it('5. the same phone under two partners signs in on each host as two sessions with distinct partners', async () => {
    await repo().upsertOnFirstInbound('pb', TWO_PARTNER_PHONE);
    const a = await codeStep(TWO_PARTNER_PHONE);
    await expectRedirect(a.verify(), '/portal');
    const tokA = h.jar.get(PORTAL_SESSION_COOKIE)!;
    h.site = SITE('pb', 'bravo');
    h.jar = new Map(); // host-only cookie: B's host never sees A's
    const b = await codeStep(TWO_PARTNER_PHONE);
    await expectRedirect(b.verify(), '/portal');
    const tokB = h.jar.get(PORTAL_SESSION_COOKIE)!;
    expect((await sessions().resolve(tokA, 'pa'))?.partnerId).toBe('pa');
    expect((await sessions().resolve(tokB, 'pb'))?.partnerId).toBe('pb');
    expect(await sessions().resolve(tokA, 'pb')).toBeNull();
    expect(await sessions().resolve(tokB, 'pa')).toBeNull();
  });

  it("6. a pending token minted on A's host is expired on B's host", async () => {
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    h.site = SITE('pb', 'bravo');
    expect(await verifyCodeAction(null, fd({ pending: s.pending!, code: lastCode(KNOWN)! }))).toEqual({
      step: 'phone',
      error: 'portal.login.expired',
    });
  });

  it('wrong / never-sent / expired codes all get ONE copy; a store error maps to it too (never success)', async () => {
    const known = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    const wrong = await verifyCodeAction(null, fd({ pending: known.pending!, code: lastCode(KNOWN) === '111111' ? '222222' : '111111' }));
    h.ip = '198.51.100.9';
    const cool = await requestCodeAction(null, fd({ phone: KNOWN })); // cooldown: no new code
    await flushAfter();
    expect(sendsTo(KNOWN)).toHaveLength(1);
    const u = await requestCodeAction(null, fd({ phone: UNKNOWN }));
    h.sends = h.sends.filter((x) => x.phone !== UNKNOWN);
    // UNKNOWN: drop the queued work, so no code was ever issued
    h.afterQ = [];
    const noCode = await verifyCodeAction(null, fd({ pending: u.pending!, code: '123456' }));
    h.failPotp = true;
    const thrown = await verifyCodeAction(null, fd({ pending: cool.pending!, code: '123456' }));
    for (const r of [wrong, noCode, thrown]) {
      expect({ ...r, pending: undefined, last4: undefined }).toEqual({ step: 'code', error: 'portal.login.code_invalid', pending: undefined, last4: undefined });
    }
  });

  it('7. five wrong codes → locked (code_invalid ×4 then try_later), audit login_locked; a new request still answers the same and sends nothing', async () => {
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    const good = lastCode(KNOWN)!;
    const bad = good === '000000' ? '000001' : '000000';
    const out: PortalLoginState[] = [];
    for (let i = 0; i < 5; i++) out.push(await verifyCodeAction(null, fd({ pending: s.pending!, code: bad })));
    expect(out.map((o) => o.error)).toEqual([...Array(4).fill('portal.login.code_invalid'), 'portal.login.try_later']);
    expect(out[4].step).toBe('phone');
    await flushAfter();
    expect(await auditCount('pa', 'portal.auth.login_locked')).toBe(1);
    expect(await auditCount('pa', 'portal.auth.login_failure')).toBe(4);
    const again = await requestCodeAction(null, fd({ phone: KNOWN }));
    expect(strip(again)).toEqual({ step: 'code', last4: '0101', notice: 'portal.login.code_sent_if_possible', pending: undefined });
    h.sends = [];
    await flushAfter();
    expect(h.sends).toEqual([]);
  });

  it('13. ceiling oracle: with the partner ceiling reached, a known (sent) and an unknown (not sent) phone answer 5 wrong codes identically, and both lock', async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    await redis.set(`potp:p:pa:${hour}`, '300');
    const k = await requestCodeAction(null, fd({ phone: KNOWN }));
    const u = await requestCodeAction(null, fd({ phone: UNKNOWN }));
    await flushAfter();
    expect(sendsTo(KNOWN)).toHaveLength(1);
    expect(sendsTo(UNKNOWN)).toHaveLength(0);
    const bad = lastCode(KNOWN) === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) {
      const rk = await verifyCodeAction(null, fd({ pending: k.pending!, code: bad }));
      const ru = await verifyCodeAction(null, fd({ pending: u.pending!, code: bad }));
      expect(strip(rk)).toEqual(strip(ru));
      expect(rk.error).toBe(i < 4 ? 'portal.login.code_invalid' : 'portal.login.try_later');
    }
    expect(await otp().isLocked('pa', KNOWN)).toBe(true);
    expect(await otp().isLocked('pa', UNKNOWN)).toBe(true);
  });

  it('per-token cap: a sixth verify on one token → try_later even when the store has budget', async () => {
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    for (let i = 0; i < 5; i++) await redis.incr(`ppend_n:${(await import('node:crypto')).createHash('sha256').update(s.pending!).digest('hex')}`);
    expect(await verifyCodeAction(null, fd({ pending: s.pending!, code: lastCode(KNOWN)! }))).toEqual({
      step: 'phone',
      error: 'portal.login.try_later',
    });
  });

  it('9. rotation: a portal cookie presented at sign-in is destroyed', async () => {
    const old = await sessions().create('pa', KNOWN, 'Safari on iOS');
    h.jar.set(PORTAL_SESSION_COOKIE, old.token);
    const { verify } = await codeStep(KNOWN);
    await expectRedirect(verify(), '/portal');
    expect(h.jar.get(PORTAL_SESSION_COOKIE)).not.toBe(old.token);
    expect(await sessions().resolve(old.token, 'pa')).toBeNull();
  });

  it('per-IP verify limit (60/h) → try_later without touching the OTP store', async () => {
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    const win = Math.floor(Date.now() / 3_600_000);
    await redis.set(`iprl|portal-verify-ip|${h.ip}|${win}`, '60');
    h.ops = [];
    expect(await verifyCodeAction(null, fd({ pending: s.pending!, code: lastCode(KNOWN)! }))).toEqual({
      step: 'phone',
      error: 'portal.login.try_later',
    });
    expect(h.ops.some((o) => o.includes('potp:'))).toBe(false);
  });
});

describe('8. TOTP-enrolled customers', () => {
  beforeEach(() => {
    h.mfaEnrolled.add(`pa|${KNOWN}`);
  });
  it('the right WhatsApp code → the mfa step (no session yet); the right TOTP → session', async () => {
    const { verify } = await codeStep(KNOWN);
    const s = await verify();
    expect(s.step).toBe('mfa');
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
    await expectRedirect(verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid })), '/portal');
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(true);
    // the sign-in proved BOTH factors: the session is step-up fresh for a TOTP-enrolled customer
    const sess = await sessions().resolve(h.jar.get(PORTAL_SESSION_COOKIE)!, 'pa');
    expect(sessions().isFresh(sess!, { requireTotp: true })).toBe(true);
  });
  it('five wrong TOTP codes → back to the phone step, audited', async () => {
    const { verify } = await codeStep(KNOWN);
    const s = await verify();
    const out: PortalLoginState[] = [];
    for (let i = 0; i < 5; i++) out.push(await verifyMfaAction(null, fd({ pending: s.pending!, code: '111111' })));
    expect(out.slice(0, 4).every((o) => o.step === 'mfa' && o.error === 'portal.login.mfa_invalid')).toBe(true);
    expect(out[4]).toEqual({ step: 'phone', error: 'portal.login.try_later' });
    await flushAfter();
    expect(await auditCount('pa', 'portal.auth.mfa_failure')).toBe(5);
    expect(await verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid }))).toEqual({ step: 'phone', error: 'portal.login.expired' });
  });
  it('M2-14 (#394 L2): the per-(partner, phone) TOTP budget spans tokens: at the daily ceiling even the right code is refused', async () => {
    const { createPortalTotpBudget, PORTAL_TOTP_FAILS_PER_DAY } = await import('@/lib/portal-totp-budget');
    const budget = createPortalTotpBudget(redis);
    // Earlier tokens already spent all but one unit today.
    for (let i = 0; i < PORTAL_TOTP_FAILS_PER_DAY - 1; i++) await budget.reserve('pa', KNOWN);
    const s = await (await codeStep(KNOWN)).verify();
    expect((await verifyMfaAction(null, fd({ pending: s.pending!, code: '111111' }))).error).toBe('portal.login.mfa_invalid');
    expect(await verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid }))).toEqual({ step: 'phone', error: 'portal.login.try_later' });
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
    // Another partner's budget for the same phone is untouched.
    expect(await budget.reserve('pb', KNOWN)).toBe(true);
  });
  it('M2-14: a success refunds its budget unit (a frequent signer-in is never locked)', async () => {
    const { createPortalTotpBudget, PORTAL_TOTP_FAILS_PER_DAY } = await import('@/lib/portal-totp-budget');
    const budget = createPortalTotpBudget(redis);
    for (let i = 0; i < PORTAL_TOTP_FAILS_PER_DAY - 1; i++) await budget.reserve('pa', KNOWN);
    for (let i = 0; i < 3; i++) {
      h.jar = new Map();
      let t = Date.now() + 61_000 * (i + 1); // past the send cooldown
      vi.spyOn(Date, 'now').mockImplementation(() => t++);
      const s = await (await codeStep(KNOWN)).verify();
      await expectRedirect(verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid })), '/portal');
      vi.restoreAllMocks();
    }
  });
  it('M2-14 (#394 L4): a Redis error in the TOTP step answers cant_send (never a 500) and never signs in', async () => {
    const s = await (await codeStep(KNOWN)).verify();
    h.failPrefix = 'ppend';
    expect(await verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid }))).toEqual({ step: 'phone', error: 'portal.login.cant_send' });
    h.failPrefix = 'ptotp:';
    expect(await verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid }))).toEqual({ step: 'phone', error: 'portal.login.cant_send' });
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
  });
  it('M2-14 (#394 L4): a Redis error creating the mfa pending after a correct WhatsApp code → cant_send', async () => {
    const { verify } = await codeStep(KNOWN);
    const orig = h.redis.set;
    h.redis.set = (...a: unknown[]) => {
      if (String(a[0]).startsWith('ppend:')) throw new Error('redis down');
      return orig(...a);
    };
    try {
      expect(await verify()).toEqual({ step: 'phone', error: 'portal.login.cant_send' });
    } finally {
      h.redis.set = orig;
    }
  });
  it("an mfa token from A's host is dead on B's", async () => {
    const { verify } = await codeStep(KNOWN);
    const s = await verify();
    h.site = SITE('pb', 'bravo');
    expect(await verifyMfaAction(null, fd({ pending: s.pending!, code: h.mfaValid }))).toEqual({ step: 'phone', error: 'portal.login.expired' });
  });
});

describe('resendCodeAction', () => {
  it('re-sends to the pending phone after the cooldown, with the same answer shape', async () => {
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    t += 61_000;
    const r = await resendCodeAction(null, fd({ pending: s.pending! }));
    expect(r).toEqual({ step: 'code', pending: s.pending, last4: '0101', notice: 'portal.login.code_sent_if_possible' });
    await flushAfter();
    expect(sendsTo(KNOWN)).toHaveLength(2);
    vi.restoreAllMocks();
  });
  it('M2-14 (#394 L7): a resend restarts the 5-minute sign-in window, so the NEW code still works after the first 5 minutes', async () => {
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const s = await requestCodeAction(null, fd({ phone: KNOWN }));
    await flushAfter();
    t += 240_000;
    await resendCodeAction(null, fd({ pending: s.pending! }));
    await flushAfter();
    t += 180_000; // 7 minutes after the first request, 3 after the resend
    await expectRedirect(verifyCodeAction(null, fd({ pending: s.pending!, code: lastCode(KNOWN)! })), '/portal');
    vi.restoreAllMocks();
  });
  it('an unknown token → expired', async () => {
    expect(await resendCodeAction(null, fd({ pending: 'b'.repeat(64) }))).toEqual({ step: 'phone', error: 'portal.login.expired' });
  });
});
