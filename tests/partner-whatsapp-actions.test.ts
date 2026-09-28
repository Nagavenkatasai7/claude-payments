import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asc } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { EnvKeyProvider } from '@/lib/field-crypto';

// UI redesign M3-13: the /partner WhatsApp actions. The tenant is the SESSION's partner only (any
// id / partnerId field in the form is ignored); admin only; secrets are write-only (never in a
// result, an audit row or a log); the audit rows carry meta.actorScope = 'partner' derived from the
// session; the test probe uses THIS partner's stored credentials only; and saves / tests are
// rate-limited per tenant, failing closed.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))) };
});
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createStore } from '@/lib/store';
import { parseChannelTest } from '@/lib/channel-health';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import {
  saveWhatsappAction,
  testWhatsappAction,
  disconnectWhatsappAction,
} from '@/app/partner/(app)/integrations/whatsapp/actions';

const PN_A = '1234567890123';
const PN_B = '9876543210987';
const SECRETS_B = { token: 'EAA-bbb-token-SECRET', appSecret: 'bbb-app-secret-SECRET', verifyToken: 'bbb-verify-SECRET' };
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const store = () => createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7)));
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const snapshot = async () => ({ a: (await store().getIntegrations('pa')).whatsapp, b: (await store().getIntegrations('pb')).whatsapp, n: (await audits()).length });
const graphOk = (id: string) => vi.fn(async () => new Response(JSON.stringify({ id }), { status: 200 }));
const PHONE_SHAPE = /\+?\d{10,}/;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  logWarnSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await store().saveIntegrations('pb', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_B, ...SECRETS_B } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ACTIONS = [
  ['saveWhatsappAction', saveWhatsappAction, () => form({ phoneNumberId: PN_A, token: 'EAA-a', appSecret: 'a-sec' })],
  ['testWhatsappAction', testWhatsappAction, () => form()],
  ['disconnectWhatsappAction', disconnectWhatsappAction, () => form()],
] as const;

describe.each(ACTIONS)('%s: the per-action checklist', (_name, action, mk) => {
  it('1. anonymous → /login; a platform account → /admin-dashboard', async () => {
    vi.stubGlobal('fetch', graphOk(PN_A));
    await expect(action(mk())).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(action(mk())).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('2. a disallowed role (agent, support, finance) → /partner with no change', async () => {
    const fetchSpy = graphOk(PN_A);
    vi.stubGlobal('fetch', fetchSpy);
    const before = JSON.stringify(await snapshot());
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(action(mk())).rejects.toThrow('REDIRECT:/partner');
    }
    expect(JSON.stringify(await snapshot())).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("3+4. a form naming B (id / partnerId / partner = pb) acts on A only; B is byte-identical", async () => {
    vi.stubGlobal('fetch', graphOk(PN_A));
    await signInAs({});
    const bBefore = JSON.stringify((await store().getIntegrations('pb')).whatsapp);
    const f = mk();
    f.set('id', 'pb');
    f.set('partnerId', 'pb');
    f.set('partner', 'pb');
    const r = await action(f);
    expect(r).toEqual({ ok: true });
    expect(JSON.stringify((await store().getIntegrations('pb')).whatsapp)).toBe(bBefore);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
    expect(JSON.stringify(rows)).not.toContain('"pb"');
  });
  it('6. success → exactly one audit row: pa, the session actor, meta.actorScope = partner, no phone / secret', async () => {
    vi.stubGlobal('fetch', graphOk(PN_A));
    await signInAs({});
    expect(await action(mk())).toEqual({ ok: true });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: 'pa' });
    expect((rows[0].meta as Record<string, unknown>).actorScope).toBe('partner');
    const meta = JSON.stringify(rows[0].meta);
    expect(meta).not.toMatch(PHONE_SHAPE);
    for (const s of ['EAA-a', 'a-sec', PN_A.slice(-4)]) expect(meta).not.toContain(s);
  });
  it('the default tenant (the shared number) is managed by SmartRemit: refused, nothing written', async () => {
    await seedPartner(db, 'default', 'Default');
    const fetchSpy = graphOk(PN_A);
    vi.stubGlobal('fetch', fetchSpy);
    await signInAs({ username: 'def-admin', partnerId: 'default' });
    const n = (await audits()).length;
    expect(await action(mk())).toEqual({ ok: false, error: t('partner.whatsapp.sharedManaged') });
    expect((await audits()).length).toBe(n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('saveWhatsappAction', () => {
  beforeEach(async () => signInAs({}));

  it('5. invalid input is refused before any write or network call (field named, value never echoed)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const before = JSON.stringify(await snapshot());
    for (const [f, key] of [
      [{ phoneNumberId: '12ab-SECRETISH' }, 'partner.whatsapp.error.phoneNumberId'],
      [{ wabaId: 'nope' }, 'partner.whatsapp.error.wabaId'],
      [{ token: 'has space SECRETISH' }, 'partner.whatsapp.error.secret'],
    ] as const) {
      const r = await saveWhatsappAction(form(f));
      expect(r).toEqual({ ok: false, error: t(key) });
      expect(JSON.stringify(r)).not.toContain('SECRETISH');
    }
    expect(JSON.stringify(await snapshot())).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stores the secrets encrypted for A and probes Graph with A’s submitted token only', async () => {
    const fetchSpy = graphOk(PN_A);
    vi.stubGlobal('fetch', fetchSpy);
    expect(await saveWhatsappAction(form({ phoneNumberId: PN_A, token: 'EAA-a-new', appSecret: 'a-sec', verifyToken: 'a-vt' }))).toEqual({ ok: true });
    expect((await store().getIntegrations('pa')).whatsapp).toEqual({ phoneNumberId: PN_A, token: 'EAA-a-new', appSecret: 'a-sec', verifyToken: 'a-vt' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${PN_A}?`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EAA-a-new');
  });

  it('a blank phone number id KEEPS the stored one (the page never renders it back): no probe, pnidChanged false', async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_A, token: 'EAA-stored', appSecret: 'sec' } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await saveWhatsappAction(form({ verifyToken: 'new-vt' }))).toEqual({ ok: true });
    expect((await store().getIntegrations('pa')).whatsapp).toEqual({ phoneNumberId: PN_A, token: 'EAA-stored', appSecret: 'sec', verifyToken: 'new-vt' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await audits();
    expect(rows[0].meta).toEqual({ pnidChanged: false, tokenChanged: false, verifyTokenChanged: true, appSecretChanged: false, pnidCleared: false, actorScope: 'partner' });
  });

  it("B's phone number id (or the platform's) is refused with the generic copy, nothing written", async () => {
    const fetchSpy = graphOk(PN_B);
    vi.stubGlobal('fetch', fetchSpy);
    const before = JSON.stringify(await snapshot());
    expect(await saveWhatsappAction(form({ phoneNumberId: PN_B, token: 'EAA-x', appSecret: 's' }))).toEqual({ ok: false, error: t('partner.whatsapp.error.numberUnavailable') });
    if (env.whatsappPhoneNumberId && /^\d{5,20}$/.test(env.whatsappPhoneNumberId)) {
      expect(await saveWhatsappAction(form({ phoneNumberId: env.whatsappPhoneNumberId, token: 'EAA-x', appSecret: 's' }))).toEqual({ ok: false, error: t('partner.whatsapp.error.numberUnavailable') });
    }
    expect(JSON.stringify(await snapshot())).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an incomplete config maps to the fixed incomplete copy; a Graph refusal to the unverified copy', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await saveWhatsappAction(form({ phoneNumberId: PN_A, token: 'EAA-x' }))).toEqual({ ok: false, error: t('partner.whatsapp.error.incomplete') });
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = await saveWhatsappAction(form({ phoneNumberId: PN_A, token: 'EAA-refused-SECRET', appSecret: 's' }));
    expect(r).toEqual({ ok: false, error: t('partner.whatsapp.error.unverified') });
    expect(await audits()).toEqual([]);
    // No secret in any log line either.
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('EAA-refused-SECRET');
  });

  it('an unexpected failure returns the generic copy and logs the error NAME only', async () => {
    vi.stubGlobal('fetch', graphOk(PN_A));
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('insert … EAA-leaky-SECRET'), { name: 'DbError' }));
    const r = await saveWhatsappAction(form({ phoneNumberId: PN_A, token: 'EAA-leaky-SECRET', appSecret: 's' }));
    spy.mockRestore();
    expect(r).toEqual({ ok: false, error: t('partner.whatsapp.failed') });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('SECRET');
  });

  it('is rate-limited per tenant (fails closed once the budget is spent)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (let i = 0; i < 10; i++) await saveWhatsappAction(form({ verifyToken: `vt-${i}` }));
    const n = (await audits()).length;
    expect(await saveWhatsappAction(form({ verifyToken: 'vt-over' }))).toEqual({ ok: false, error: t('partner.whatsapp.rateLimited') });
    expect((await audits()).length).toBe(n);
  });

  it('a limiter (Redis) failure fails closed: refused, nothing written', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const spy = vi.spyOn(redis, 'incr').mockRejectedValueOnce(new Error('redis down'));
    const r = await saveWhatsappAction(form({ verifyToken: 'vt' }));
    spy.mockRestore();
    expect(r).toEqual({ ok: false, error: t('partner.whatsapp.rateLimited') });
    expect(await audits()).toEqual([]);
  });
});

describe('testWhatsappAction', () => {
  beforeEach(async () => signInAs({}));

  it("probes with A's STORED token and number only, stores the result for A, audits ok/status only", async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_A, token: 'EAA-a-stored', appSecret: 'sec' } });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await testWhatsappAction(form())).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${PN_A}?`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EAA-a-stored');
    const res = parseChannelTest(await createStore(redis, db).readChannelTest('pa'));
    expect(res).toMatchObject({ ok: false, reason: 'probe_failed', status: 401 });
    expect(await createStore(redis, db).readChannelTest('pb')).toBeNull();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'partner.whatsapp.test', partnerId: 'pa', actor: 'pa-admin' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner', ok: false, status: 401, reason: 'probe_failed' });
  });

  it('an unconfigured tenant makes ZERO network calls (never falls back to the shared number)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await testWhatsappAction(form())).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(parseChannelTest(await createStore(redis, db).readChannelTest('pa'))).toMatchObject({ ok: false, reason: 'not_configured' });
    expect((await audits())[0].meta).toEqual({ actorScope: 'partner', ok: false, reason: 'not_configured' });
  });

  it('is rate-limited per tenant (5 per window), failing closed', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (let i = 0; i < 5; i++) expect(await testWhatsappAction(form())).toEqual({ ok: true });
    expect(await testWhatsappAction(form())).toEqual({ ok: false, error: t('partner.whatsapp.rateLimited') });
    expect(await audits()).toHaveLength(5);
  });
});

describe('disconnectWhatsappAction', () => {
  beforeEach(async () => signInAs({}));

  it("clears A's four fields only, one row with actorScope partner", async () => {
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN_A, token: 'EAA-a', appSecret: 'sec', verifyToken: 'vt' } });
    expect(await disconnectWhatsappAction(form({ id: 'pb' }))).toEqual({ ok: true });
    expect((await store().getIntegrations('pa')).whatsapp).toEqual({});
    expect((await store().getIntegrations('pb')).whatsapp).toEqual({ phoneNumberId: PN_B, ...SECRETS_B });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'partner.whatsapp.disconnect', partnerId: 'pa', actor: 'pa-admin', meta: { actorScope: 'partner' } });
  });

  it('is rate-limited per tenant (fails closed), so a session cannot flood the audit log', async () => {
    for (let i = 0; i < 5; i++) expect(await disconnectWhatsappAction(form())).toEqual({ ok: true });
    expect(await disconnectWhatsappAction(form())).toEqual({ ok: false, error: t('partner.whatsapp.rateLimited') });
    expect(await audits()).toHaveLength(5);
  });
});
