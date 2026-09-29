import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { createCustomerMfaStore } from '@/lib/customer-mfa';
import { auditSubjectId } from '@/lib/customer-ref';
import { base32Decode, totpAt } from '@/lib/totp';
import { kycView, maskLegalName, profileView } from '@/lib/portal-profile';
import type { Customer } from '@/lib/types';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners } from './helpers-portal-two-partner';

// UI redesign M2-11, Tasks 11.1-11.2: the Profile page (masked; one pii.view per render), the audited
// legal-name reveal, the KYC start through the SHARED core (startCustomerVerification) and TOTP
// enrolment behind the 15-minute step-up with the partner's brand as the issuer (owner O7).

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  stale: false,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  ps: null as unknown,
  cs: null as unknown,
  kcs: null as unknown,
  mfa: null as unknown,
  sessions: { revokeAll: vi.fn(async () => 0), markStepUp: vi.fn(async () => true) },
  startVerification: vi.fn(async () => ({ url: 'https://kyc.example.com/flow?x=1', providerRef: 'inq_9' })),
}));

vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.ctx,
  requirePortalCustomer: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
  requireFreshPortalAuth: async (returnTo: string) => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    if (h.stale) throw new Error(`REDIRECT:/portal/verify?next=${returnTo}`);
    return h.ctx;
  },
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'acme.smartremit.ai' }) }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => h.cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig<typeof import('@/lib/kyc-case-store')>()), getKycCaseStore: () => h.kcs }));
vi.mock('@/lib/providers/kyc-provider', () => ({ getKycProvider: () => ({ startVerification: h.startVerification }) }));
vi.mock('@/lib/customer-mfa', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-mfa')>()), getCustomerMfaStore: () => h.mfa }));
// M2-14 (#399 L2): the portal enrolment also signs out the legacy /account sessions of this phone
// when that legacy account belongs to THIS partner.
const legacyAuth = vi.hoisted(() => ({ partnerId: 'pa' as string | null, deleteAllSessions: vi.fn(async () => undefined) }));
vi.mock('@/lib/customer-auth-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/customer-auth-store')>()),
  getCustomerAuthStore: () => ({
    getCustomer: async () => (legacyAuth.partnerId ? { partnerId: legacyAuth.partnerId } : null),
    deleteAllSessions: legacyAuth.deleteAllSessions,
  }),
}));
vi.mock('@/lib/portal-session-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/portal-session-store')>()),
  getPortalSessionStore: () => h.sessions,
}));

import ProfilePage from '@/app/portal/profile/page';
import {
  beginPortalMfaEnrolmentAction,
  confirmPortalMfaEnrolmentAction,
  revealPortalLegalNameAction,
  startPortalVerificationAction,
} from '@/app/portal/profile/actions';

const SITE = (partnerId: string) => ({ partnerId, slug: partnerId === 'pa' ? 'acme' : 'bolt', brand: partnerId === 'pa' ? 'Acme Remit' : 'Bolt Pay', logo: null, theme: {} });
const NAME_A = 'Alice Example';
const NAME_B = 'Bea Sample';

let db: Db;
let redis: FakeRedis;
let ps: PartnerStore;
let cs: CustomerStore;
let phone: string;
let clock = Date.now();

async function signIn(partnerId: string) {
  h.site = SITE(partnerId);
  const customer = (await cs.getCustomer(partnerId, phone)) as Customer;
  h.ctx = { site: h.site, session: { phone, sid: `sid-${partnerId}` }, token: `tok-${partnerId}`, customer };
}

async function setPartner(id: string, patch: Record<string, unknown>) {
  const p = await ps.getPartner(id);
  await ps.savePartner({ ...p!, ...patch, updatedAt: new Date().toISOString() });
}

const audits = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const fd = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(async () => {
  db = await freshDb();
  ({ phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  ps = createPartnerStore(db);
  h.ps = ps;
  cs = createCustomerStore(db, h.store as never);
  h.cs = cs;
  h.kcs = createKycCaseStore(redis, cs);
  clock = Date.now();
  h.mfa = createCustomerMfaStore(redis, cs, { now: () => clock });
  h.stale = false;
  h.sessions.revokeAll.mockClear();
  legacyAuth.partnerId = 'pa';
  legacyAuth.deleteAllSessions.mockClear();
  h.sessions.markStepUp.mockClear();
  h.startVerification.mockClear();
  await cs.setFullNameIfUnset('pa', phone, NAME_A);
  await cs.setFullNameIfUnset('pb', phone, NAME_B);
  await cs.setEmail('pa', phone, 'alice@example.com');
  await signIn('pa');
});

describe('view model (pure)', () => {
  it('maskLegalName keeps first letters only', () => {
    expect(maskLegalName('Alice Example')).toBe('A••• E•••');
    expect(maskLegalName('  ')).toBeNull();
    expect(maskLegalName(undefined)).toBeNull();
  });
  it('kycView maps status + review state; only a not-started row offers the start', () => {
    expect(kycView({ kycStatus: 'verified' } as Customer)).toMatchObject({ label: 'portal.kyc.status.verified', canStart: false });
    expect(kycView({ kycStatus: 'pending', kycReviewState: 'pending_review' } as Customer)).toMatchObject({ label: 'portal.kyc.status.review', canStart: false });
    expect(kycView({ kycStatus: 'rejected' } as Customer)).toMatchObject({ canStart: false });
    expect(kycView({ kycStatus: 'not_started' } as Customer)).toMatchObject({ label: 'portal.kyc.status.none', canStart: true });
  });
  it('a started but unfinished verification can be resumed (never stuck on "In review")', () => {
    expect(kycView({ kycStatus: 'pending', kycReviewState: 'inquiry_started' } as Customer)).toMatchObject({
      label: 'portal.kyc.status.started',
      canStart: true,
    });
    expect(kycView({ kycStatus: 'pending', kycReviewState: 'needs_review' } as Customer)).toMatchObject({ label: 'portal.kyc.status.review', canStart: false });
  });
  it('profileView masks phone, name and email and names the fields shown', async () => {
    const v = profileView((await cs.getCustomer('pa', phone))!);
    expect(v.phone).toBe(`••••${phone.slice(-4)}`);
    expect(v.legalName).toBe('A••• E•••');
    expect(v.email).toBe('a•••@example.com');
    expect(v.fields).toEqual(['phone', 'full_name', 'email']);
  });
});

describe('Profile page', () => {
  const render = async () => renderToStaticMarkup(await ProfilePage());
  it('apex / portal off → 404; signed out → sign-in', async () => {
    h.site = null;
    await expect(ProfilePage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    h.site = SITE('pa');
    h.ctx = null;
    await expect(ProfilePage()).rejects.toThrow('REDIRECT:/portal/login');
  });
  it('shows masked values only (never the phone, the name or the address) and writes ONE pii.view per render', async () => {
    const html = await render();
    expect(html).not.toContain(phone);
    expect(html).not.toContain(NAME_A);
    expect(html).not.toContain('alice@example.com');
    expect(html).toContain(phone.slice(-4));
    expect(html).toContain('a•••@example.com');
    await render();
    const rows = await audits('pii.view');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      partnerId: 'pa',
      actor: 'system:customer-portal',
      actorType: 'system',
      subjectId: auditSubjectId('pa', phone),
      meta: { fields: ['phone', 'full_name', 'email'], by: 'customer', via: 'portal.profile' },
    });
    expect(JSON.stringify(rows)).not.toContain(phone);
  });
  it("partner B's session sees B's row (B has no email) and audits under B", async () => {
    await signIn('pb');
    const html = await render();
    expect(html).not.toContain('a•••@example.com');
    expect(html).toContain('B••• S•••');
    const rows = await audits('pii.view');
    expect(rows.map((r) => r.partnerId)).toEqual(['pb']);
  });
  it('a rejected customer sees "contact the partner" and no start button', async () => {
    await setPartner('pa', { requireKycBeforeSend: true });
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, kycStatus: 'rejected' });
    await signIn('pa');
    const html = await render();
    expect(html).toContain('Contact Acme Remit');
    expect(html).not.toContain('Verify your identity</button>');
  });
  it('a delegated partner shows the provider copy and no start button', async () => {
    await setPartner('pa', { kycMode: 'delegated', requireKycBeforeSend: true });
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, kycStatus: 'not_started' });
    await signIn('pa');
    const html = await render();
    expect(html).toContain('Acme Remit verifies your identity');
    expect(html).not.toContain('Verify your identity</button>');
  });
});

describe('revealPortalLegalNameAction', () => {
  it('gates on the host first, then the session', async () => {
    h.site = null;
    await expect(revealPortalLegalNameAction()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    h.site = SITE('pa');
    h.ctx = null;
    await expect(revealPortalLegalNameAction()).rejects.toThrow('REDIRECT:/portal/login');
  });
  it("returns the session's own name and audits pii.reveal {field:'full_name', by:'customer'}", async () => {
    expect(await revealPortalLegalNameAction()).toEqual({ value: NAME_A });
    const rows = await audits('pii.reveal');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', subjectId: auditSubjectId('pa', phone), meta: { field: 'full_name', by: 'customer' } });
  });
  it("on B's host it can only ever return B's name", async () => {
    await signIn('pb');
    expect(await revealPortalLegalNameAction()).toEqual({ value: NAME_B });
    expect((await audits('pii.reveal'))[0].partnerId).toBe('pb');
  });
  it('M2-14 (#399 L6): the reveal audit write fails → an error, and the name is NEVER returned (fail closed)', async () => {
    const real = h.db as Db;
    h.db = new Proxy(real, {
      get(t, k) {
        if (k === 'insert') return () => { throw new Error('db down'); };
        return Reflect.get(t, k);
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await revealPortalLegalNameAction();
      expect(r).toEqual({ error: 'unavailable' });
      expect(JSON.stringify(r)).not.toContain(NAME_A);
    } finally {
      h.db = real;
      warn.mockRestore();
    }
    expect(await audits('pii.reveal')).toHaveLength(0);
  });

  it('no name on file → one error, no audit row', async () => {
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, fullName: undefined });
    await signIn('pa');
    expect(await revealPortalLegalNameAction()).toEqual({ error: 'unavailable' });
    expect(await audits('pii.reveal')).toHaveLength(0);
  });
});

describe('startPortalVerificationAction', () => {
  beforeEach(async () => {
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, kycStatus: 'not_started' });
    await setPartner('pa', { requireKycBeforeSend: true, kycMode: 'ours' });
    await signIn('pa');
  });
  it('gates on the host first, then the session', async () => {
    h.site = null;
    await expect(startPortalVerificationAction(null, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    h.site = SITE('pa');
    h.ctx = null;
    await expect(startPortalVerificationAction(null, fd())).rejects.toThrow('REDIRECT:/portal/login');
  });
  it('gate on → the shared core under the portal actor, then a redirect to the hosted flow', async () => {
    await expect(startPortalVerificationAction(null, fd())).rejects.toThrow('REDIRECT:https://kyc.example.com/flow?x=1');
    expect(h.startVerification).toHaveBeenCalledWith({ customerId: phone, senderPhone: phone });
    expect(await (await cs.getCustomer('pa', phone))?.kycReviewState).toBe('inquiry_started');
    expect(await (await cs.getCustomer('pb', phone))?.kycReviewState).not.toBe('inquiry_started');
    const kcs = h.kcs as ReturnType<typeof createKycCaseStore>;
    expect((await kcs.getAudit('pa', phone)).at(-1)).toMatchObject({ action: 'kyc.start', actor: 'system:customer-portal' });
    expect(await kcs.getAudit('pb', phone)).toEqual([]);
  });
  it('delegated partner → the provider copy; the provider is never touched', async () => {
    await setPartner('pa', { kycMode: 'delegated' });
    expect(await startPortalVerificationAction(null, fd())).toEqual({ notice: 'portal.kyc.delegated' });
    expect(h.startVerification).not.toHaveBeenCalled();
  });
  it('gate off → "not required"; already verified → no new inquiry', async () => {
    await setPartner('pa', { requireKycBeforeSend: false });
    expect(await startPortalVerificationAction(null, fd())).toEqual({ notice: 'portal.kyc.not_required' });
    await setPartner('pa', { requireKycBeforeSend: true });
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, kycStatus: 'verified' });
    await signIn('pa');
    expect(await startPortalVerificationAction(null, fd())).toEqual({ notice: 'portal.kyc.already' });
    expect(h.startVerification).not.toHaveBeenCalled();
  });
  it('a REJECTED customer cannot start verification again in the portal (owner: they contact the partner)', async () => {
    await setPartner('pa', { requireKycBeforeSend: true });
    await cs.saveCustomer({ ...(await cs.getCustomer('pa', phone))!, kycStatus: 'rejected' });
    await signIn('pa');
    expect(await startPortalVerificationAction(null, fd())).toEqual({ notice: 'portal.kyc.already' });
    expect(h.startVerification).not.toHaveBeenCalled();
  });
  it('rate-limited per customer (5 an hour)', async () => {
    for (let i = 0; i < 5; i++) await expect(startPortalVerificationAction(null, fd())).rejects.toThrow('REDIRECT:');
    expect(await startPortalVerificationAction(null, fd())).toEqual({ error: 'portal.kyc.rate_limited' });
    expect(h.startVerification).toHaveBeenCalledTimes(5);
  });
});

describe('TOTP enrolment (step-up; partner brand issuer)', () => {
  it('gates on the host, then a FRESH session (the step-up returns to /portal/profile)', async () => {
    h.site = null;
    await expect(beginPortalMfaEnrolmentAction({ ok: false }, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    await expect(confirmPortalMfaEnrolmentAction({ ok: false }, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    h.site = SITE('pa');
    h.stale = true;
    await expect(beginPortalMfaEnrolmentAction({ ok: false }, fd())).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/profile');
    await expect(confirmPortalMfaEnrolmentAction({ ok: false }, fd())).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/profile');
  });
  it("begin → the partner's brand as issuer; confirm → enrolled on THIS tenant only, other sessions revoked, step-up stamped, audited", async () => {
    const begun = await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    expect(begun.ok).toBe(true);
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\/Acme%20Remit:/);
    const secret = base32Decode(begun.secret!);
    clock += 31_000;
    const done = await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: totpAt(secret, clock) }));
    expect(done).toEqual({ ok: true, notice: 'portal.mfa.on' });
    expect(await cs.isMfaEnrolled('pa', phone)).toBe(true);
    expect(await cs.isMfaEnrolled('pb', phone)).toBe(false);
    expect(h.sessions.revokeAll).toHaveBeenCalledWith('pa', phone, 'sid-pa');
    expect(legacyAuth.deleteAllSessions).toHaveBeenCalledWith(phone); // M2-14 (#399 L2)
    expect(h.sessions.markStepUp).toHaveBeenCalledWith('tok-pa', 'pa', { totp: true });
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'customer.mfa.enroll'), eq(auditEvents.partnerId, 'pa')));
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe(auditSubjectId('pa', phone));
    expect(rows[0].actor).toBe('system:customer-portal'); // M2-14 (#399 L3): the portal actor
  });
  it("M2-14 (#399 L2): a legacy account under ANOTHER partner is left alone; a failed legacy revoke is reported", async () => {
    legacyAuth.partnerId = 'pb';
    let begun = await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    clock += 31_000;
    expect(await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: totpAt(base32Decode(begun.secret!), clock) }))).toEqual({ ok: true, notice: 'portal.mfa.on' });
    expect(legacyAuth.deleteAllSessions).not.toHaveBeenCalled();

    await signIn('pb');
    legacyAuth.deleteAllSessions.mockRejectedValueOnce(new Error('redis down'));
    begun = await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    clock += 31_000;
    expect(await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: totpAt(base32Decode(begun.secret!), clock) }))).toEqual({ ok: true, notice: 'portal.mfa.on_revoke_failed' });
  });
  it('if signing out the other sessions fails, the notice says so (never claims the devices were signed out)', async () => {
    h.sessions.revokeAll.mockRejectedValueOnce(new Error('redis down'));
    const begun = await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    clock += 31_000;
    const done = await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: totpAt(base32Decode(begun.secret!), clock) }));
    expect(done).toEqual({ ok: true, notice: 'portal.mfa.on_revoke_failed' });
    expect(await cs.isMfaEnrolled('pa', phone)).toBe(true);
  });
  it('a wrong code → one error, nothing enrolled; already enrolled → refused', async () => {
    await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    expect(await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: '000000' }))).toEqual({ ok: false, error: 'portal.mfa.invalid' });
    expect(await cs.isMfaEnrolled('pa', phone)).toBe(false);
    const begun = await beginPortalMfaEnrolmentAction({ ok: false }, fd());
    clock += 31_000;
    await confirmPortalMfaEnrolmentAction({ ok: false }, fd({ code: totpAt(base32Decode(begun.secret!), clock) }));
    expect(await beginPortalMfaEnrolmentAction({ ok: false }, fd())).toEqual({ ok: false, error: 'portal.mfa.already' });
  });
});
