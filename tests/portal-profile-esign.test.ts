import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import type { PortalSite } from '@/lib/portal-site';
import { renderToStaticMarkup } from 'react-dom/server';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, customers } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { profileView } from '@/lib/portal-profile';
import { createStore } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { createCustomerMfaStore } from '@/lib/customer-mfa';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { readEsignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_TITLE, ESIGN_CONSENT_VERSION, ESIGN_WITHDRAW_COPY } from '@/lib/legal/esign-consent';
import { t } from '@/lib/i18n';
import type { Customer } from '@/lib/types';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { seedTwoPartners } from './helpers-portal-two-partner';
import { seedEsignConsentForTest } from './helpers-esign';

// Fix pack 6 T8 (R46, P9, P21 row 2): the portal Profile "Electronic records" card and
// withdrawEsignConsentAction. Host partner + session phone only; one transaction for the
// stamp and its audit row; idempotent. Mock block copied from tests/portal-profile.test.ts.

const h = vi.hoisted(() => ({
  site: null as null | PortalSite,
  ctx: null as null | Record<string, unknown>,
  db: null as unknown,
  getDbCalls: 0,
  redis: null as unknown,
  store: null as unknown,
  ps: null as unknown,
  cs: null as unknown,
  kcs: null as unknown,
  mfa: null as unknown,
  logWarn: vi.fn(),
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
  requireFreshPortalAuth: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
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
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => {
    h.getDbCalls += 1;
    return h.db;
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => h.cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig<typeof import('@/lib/kyc-case-store')>()), getKycCaseStore: () => h.kcs }));
vi.mock('@/lib/customer-mfa', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-mfa')>()), getCustomerMfaStore: () => h.mfa }));
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: h.logWarn }));

import ProfilePage from '@/app/portal/profile/page';
import { withdrawEsignConsentAction } from '@/app/portal/profile/actions';

const SITE = (partnerId: string): PortalSite => ({ partnerId, slug: partnerId === 'pa' ? 'acme' : 'bolt', host: partnerId === 'pa' ? 'acme.smartremit.ai' : 'bolt.smartremit.ai', brand: 'SmartRemit', logo: null, theme: {} as PortalSite['theme'] });

let db: Db;
let ps: PartnerStore;
let cs: CustomerStore;
let phone: string;

async function signIn(partnerId: string) {
  h.site = SITE(partnerId);
  const customer = (await cs.getCustomer(partnerId, phone)) as Customer;
  h.ctx = { site: h.site, session: { phone, sid: `sid-${partnerId}` }, token: `tok-${partnerId}`, customer };
}

const esignAudits = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'customer.consent.esign'));
const consentRow = async (partnerId: string, p = phone) =>
  (
    await db
      .select({ version: customers.esignConsentVersion, consentedAt: customers.esignConsentedAt, withdrawnAt: customers.esignWithdrawnAt, updatedAt: customers.updatedAt })
      .from(customers)
      .where(and(eq(customers.partnerId, partnerId), eq(customers.phone, p)))
  )[0];
const fd = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(async () => {
  db = await freshDb();
  ({ phone } = await seedTwoPartners(db));
  const redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  ps = createPartnerStore(db);
  h.ps = ps;
  cs = createCustomerStore(db, h.store as never);
  h.cs = cs;
  h.kcs = createKycCaseStore(redis, cs);
  h.mfa = createCustomerMfaStore(redis, cs);
  h.logWarn.mockClear();
  // consent on file for BOTH tenants of the same phone
  await seedEsignConsentForTest(db, 'pa', phone);
  await seedEsignConsentForTest(db, 'pb', phone);
  await signIn('pa');
  h.getDbCalls = 0;
});

describe('withdrawEsignConsentAction', () => {
  it('gates on the host first, then the session', async () => {
    h.site = null;
    await expect(withdrawEsignConsentAction(null, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(h.getDbCalls).toBe(0);
    h.site = SITE('pa');
    h.ctx = null;
    await expect(withdrawEsignConsentAction(null, fd())).rejects.toThrow('REDIRECT:/portal/login');
    expect(h.getDbCalls).toBe(0);
    expect((await consentRow('pa')).withdrawnAt).toBeNull();
    expect(await esignAudits()).toHaveLength(0);
  });

  it("on pa's host: withdraws pa's consent only; pb's row with the same phone is untouched", async () => {
    const pbBefore = await consentRow('pb');
    expect(await withdrawEsignConsentAction(null, fd())).toEqual({ notice: 'portal.profile.esign.withdrawn' });
    const pa = await consentRow('pa');
    expect(pa.withdrawnAt).not.toBeNull();
    expect(pa.withdrawnAt!.getTime()).toBeGreaterThanOrEqual(pa.consentedAt!.getTime());
    expect(await consentRow('pb')).toEqual(pbBefore);
  });

  it('writes ONE audit row customer.consent.esign with the P21 row 2 shape (no phone, no name)', async () => {
    await withdrawEsignConsentAction(null, fd());
    const rows = await esignAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: PORTAL_AUTH_ACTOR, actorType: 'system', subjectId: auditSubjectId('pa', phone) });
    expect(rows[0].meta).toEqual({ version: ESIGN_CONSENT_VERSION, on: false, via: 'portal' });
    expect(JSON.stringify(rows[0])).not.toContain(phone);
  });

  it('idempotent: a second call returns the same notice, writes no second row, leaves withdrawn_at unchanged', async () => {
    await withdrawEsignConsentAction(null, fd());
    const first = await consentRow('pa');
    expect(await withdrawEsignConsentAction(null, fd())).toEqual({ notice: 'portal.profile.esign.withdrawn' });
    expect(await consentRow('pa')).toEqual(first);
    expect(await esignAudits()).toHaveLength(1);
  });

  it('nothing on file (never consented) -> the same notice, no audit row, no customers write', async () => {
    const other = '14155550199';
    await createCustomerRepo(db, async () => null).ensureCustomer('pa', other);
    const before = await consentRow('pa', other);
    h.ctx = { ...(h.ctx as object), session: { phone: other, sid: 'sid-x' }, customer: await cs.getCustomer('pa', other) };
    expect(await withdrawEsignConsentAction(null, fd())).toEqual({ notice: 'portal.profile.esign.withdrawn' });
    expect(await consentRow('pa', other)).toEqual(before);
    expect(await esignAudits()).toHaveLength(0);
  });

  it('form fields are ignored: a body carrying partnerId pb and another phone still withdraws (pa, session phone) only', async () => {
    const pbBefore = await consentRow('pb');
    const res = await withdrawEsignConsentAction(null, fd({ partnerId: 'pb', phone: '14155550199', senderPhone: '14155550199' }));
    expect(res).toEqual({ notice: 'portal.profile.esign.withdrawn' });
    expect((await consentRow('pa')).withdrawnAt).not.toBeNull();
    expect(await consentRow('pb')).toEqual(pbBefore);
    const rows = await esignAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
  });

  it('the audit insert fails -> portal.action.failed; the consent is NOT withdrawn; logWarn with the error name only', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_esign_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_esign_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'customer.consent.esign') EXECUTE FUNCTION fail_esign_audit()`));
    // freshDb truncates tables but keeps triggers: drop it for the next test.
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_esign_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_esign_audit()'));
    });
    expect(await withdrawEsignConsentAction(null, fd())).toEqual({ error: 'portal.action.failed' });
    expect((await consentRow('pa')).withdrawnAt).toBeNull();
    expect(await esignAudits()).toHaveLength(0);
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    const [scope, detail, ...rest] = h.logWarn.mock.calls[0];
    expect(scope).toBe('portal.profile.esign');
    expect(typeof detail).toBe('string');
    expect(detail).not.toContain('audit-leak');
    expect(rest).toEqual([]);
  });

  it('after withdrawal esignConsentNeeded is true for (pa, phone) and still false for pb', async () => {
    expect(await readEsignConsentNeeded(db, 'pa', phone)).toBe(false);
    await withdrawEsignConsentAction(null, fd());
    expect(await readEsignConsentNeeded(db, 'pa', phone)).toBe(true);
    expect(await readEsignConsentNeeded(db, 'pb', phone)).toBe(false);
  });
});

describe('Profile page: Electronic records card', () => {
  const render = async () => renderToStaticMarkup(await ProfilePage());
  // renderToStaticMarkup's text escaping (& < > " ').
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

  it('the card heading is ESIGN_CONSENT_TITLE and every ESIGN_WITHDRAW_COPY line is in the HTML', async () => {
    const html = await render();
    expect(html).toContain(`>${esc(ESIGN_CONSENT_TITLE)}</h2>`);
    for (const line of ESIGN_WITHDRAW_COPY) expect(html).toContain(esc(line));
  });

  it('consent on file -> the on copy and the Withdraw button', async () => {
    const html = await render();
    expect(html).toContain(esc(t('portal.profile.esign.on')));
    expect(html).not.toContain(esc(t('portal.profile.esign.off')));
    expect(html).toContain(esc(t('portal.profile.esign.withdraw')));
  });

  it('not on file / withdrawn / an older version -> the off copy, no button', async () => {
    const cases: Array<() => Promise<void>> = [
      async () => {
        const other = '14155550199';
        await createCustomerRepo(db, async () => null).ensureCustomer('pa', other);
        h.ctx = { ...(h.ctx as object), session: { phone: other, sid: 'sid-x' }, customer: await cs.getCustomer('pa', other) };
      },
      async () => {
        await seedEsignConsentForTest(db, 'pa', phone, { withdrawn: true });
        await signIn('pa');
      },
      async () => {
        await seedEsignConsentForTest(db, 'pa', phone, { version: 'esign-older' });
        await signIn('pa');
      },
    ];
    for (const setUp of cases) {
      await setUp();
      const html = await render();
      expect(html).toContain(esc(t('portal.profile.esign.off')));
      expect(html).not.toContain(esc(t('portal.profile.esign.on')));
      expect(html).not.toContain(esc(t('portal.profile.esign.withdraw')));
      for (const line of ESIGN_WITHDRAW_COPY) expect(html).toContain(esc(line));
    }
  });

  it('the card adds no pii.view field and shows no phone', async () => {
    const html = await render();
    expect(html).not.toContain(phone);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'pii.view'));
    expect(rows).toHaveLength(1);
    expect((rows[0].meta as { fields?: unknown }).fields).toEqual(profileView((h.ctx as { customer: Customer }).customer).fields);
  });
});
