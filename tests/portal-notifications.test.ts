import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, customers, outbox } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { suppressForOptOut } from '@/lib/consent-gate';
import { emailVerifiedTag, getPortalPrefs, markEmailVerified } from '@/lib/portal-prefs';
import { renderSealedText } from '@/lib/sealed-text';
import { newRequestKey } from '@/lib/portal-request-key';
import { auditSubjectId } from '@/lib/customer-ref';
import type { Customer } from '@/lib/types';
import { freshDb, seedSender } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners } from './helpers-portal-two-partner';

// UI redesign M2-11, Tasks 11.3-11.4: WhatsApp on/off = EXACTLY the bot's STOP/START writes; the email
// change (step-up, single-column, one verify email per submit, rate-limited, sealed link on the
// partner's own host); the verify link (GET never consumes; the POST consumes only for the token's
// own host + customer + current address); email receipts only once verified.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  stale: false,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  pokes: 0,
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
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => void h.pokes++, pokeWorkerDelayed: () => undefined }));
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendText: vi.fn(async () => {}) }));

import { setEmailReceiptsAction, setWhatsappNotificationsAction, updateEmailAction } from '@/app/portal/notifications/actions';
import { verifyEmailAction } from '@/app/portal/notifications/verify/actions';
import VerifyEmailPage from '@/app/portal/notifications/verify/page';
import NotificationsPage from '@/app/portal/notifications/page';
import { processInboundWebhook } from '@/lib/whatsapp-inbound';

const SITE = (partnerId: string) => ({ partnerId, slug: partnerId === 'pa' ? 'acme' : 'bolt', brand: partnerId === 'pa' ? 'Acme Remit' : 'Bolt Pay', logo: null, theme: {} });
const EMAIL = 'alice@example.com';

let db: Db;
let redis: FakeRedis;
let cs: CustomerStore;
let phone: string;

async function signIn(partnerId: string, p = phone) {
  h.site = SITE(partnerId);
  const customer = (await cs.getCustomer(partnerId, p)) as Customer;
  h.ctx = { site: h.site, session: { phone: p, sid: `sid-${partnerId}` }, token: `tok-${partnerId}`, customer };
}
const fd = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const emailFd = (email = EMAIL, requestKey = newRequestKey()) => fd({ email, requestKey });
const audits = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const emailRows = () => db.select().from(outbox).where(eq(outbox.kind, 'email.send'));
const row = async (pid: string, p = phone) => (await db.select().from(customers).where(and(eq(customers.partnerId, pid), eq(customers.phone, p))))[0];

/** The verify link's token, read back out of the newest sealed email.send row. */
async function lastToken(): Promise<string> {
  const rows = await emailRows();
  const p = rows.at(-1)!.payload as { text: string; sealed: unknown };
  const m = /verify\?token=([A-Za-z0-9_-]{43})/.exec(renderSealedText(p.text, p.sealed));
  if (!m) throw new Error('no token');
  return m[1];
}

beforeEach(async () => {
  db = await freshDb();
  ({ phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  cs = createCustomerStore(db, h.store as never);
  h.stale = false;
  h.pokes = 0;
  await signIn('pa');
});

describe('gates', () => {
  it('apex / portal off → 404 before anything; signed out → sign-in; the email change needs a FRESH session', async () => {
    h.site = null;
    for (const a of [setWhatsappNotificationsAction, setEmailReceiptsAction, updateEmailAction, verifyEmailAction]) {
      await expect(a(null, fd({ on: '0' }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    }
    h.site = SITE('pa');
    h.ctx = null;
    for (const a of [setWhatsappNotificationsAction, setEmailReceiptsAction, updateEmailAction, verifyEmailAction]) {
      await expect(a(null, fd({ on: '0' }))).rejects.toThrow('REDIRECT:/portal/login');
    }
    await signIn('pa');
    h.stale = true;
    await expect(updateEmailAction(null, emailFd())).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/notifications');
    expect(await emailRows()).toHaveLength(0);
  });
});

describe('WhatsApp on/off = the bot STOP/START writes', () => {
  const BOT = '14155550177';
  const inbound = (text: string, id: string) =>
    processInboundWebhook(
      { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: BOT, id, type: 'text', text: { body: text } }] } }] }] },
      { routedPartnerId: 'pa' },
    );
  const cols = async (p: string) => {
    const r = await row('pa', p);
    return { optedOut: r.optedOutAt !== null, optInAt: r.optInAt };
  };

  it('parity: off ≡ STOP, on ≡ START (opted_out_at set/cleared; opt_in_at never stamped); B and the other tenant untouched', async () => {
    await seedSender(db, { partnerId: 'pa', phone: BOT });
    await inbound('STOP', 'wamid.P1');
    expect(await setWhatsappNotificationsAction(null, fd({ on: '0' }))).toEqual({ notice: 'portal.notify.wa_off' });
    expect(await cols(phone)).toEqual(await cols(BOT));
    expect((await cols(phone)).optedOut).toBe(true);
    await inbound('START', 'wamid.P2');
    expect(await setWhatsappNotificationsAction(null, fd({ on: '1' }))).toEqual({ notice: 'portal.notify.wa_on' });
    expect(await cols(phone)).toEqual(await cols(BOT));
    expect((await cols(phone)).optedOut).toBe(false);
    expect((await row('pb')).optedOutAt).toBeNull();
  });

  it('suppressForOptOut flips for nonessential only; audit customer.consent.whatsapp {on, via}', async () => {
    await setWhatsappNotificationsAction(null, fd({ on: '0' }));
    expect(await suppressForOptOut(cs, 'pa', phone, 'nonessential')).toBe(true);
    expect(await suppressForOptOut(cs, 'pa', phone, 'essential')).toBe(false);
    expect(await suppressForOptOut(cs, 'pb', phone, 'nonessential')).toBe(false);
    await setWhatsappNotificationsAction(null, fd({ on: '1' }));
    expect(await suppressForOptOut(cs, 'pa', phone, 'nonessential')).toBe(false);
    const rows = await audits('customer.consent.whatsapp');
    expect(rows.map((r) => r.meta)).toEqual([{ on: false, via: 'portal' }, { on: true, via: 'portal' }]);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'system:customer-portal', subjectId: auditSubjectId('pa', phone) });
  });

  it('a malformed choice changes nothing', async () => {
    expect(await setWhatsappNotificationsAction(null, fd({ on: 'yes' }))).toEqual({ error: 'portal.action.failed' });
    expect((await row('pa')).optedOutAt).toBeNull();
  });
});

describe('updateEmailAction', () => {
  it('refuses an invalid address (no write, no email)', async () => {
    for (const bad of ['nope', 'a@b', `${'a'.repeat(250)}@example.com`, 'x@example.com\nBcc: y@example.com']) {
      expect(await updateEmailAction(null, emailFd(bad))).toEqual({ error: 'portal.email.invalid' });
    }
    expect(await emailRows()).toHaveLength(0);
    expect((await row('pa')).emailEnc).toBeNull();
  });

  it('writes the sealed address (single column), voids verification, ONE sealed email with the link on the partner host, audit without the address; a double submit sends one', async () => {
    await markEmailVerified(db, 'pa', phone, 'old-tag');
    const before = await row('pa');
    const f = emailFd();
    expect(await updateEmailAction(null, f)).toEqual({ notice: 'portal.email.sent' });
    expect(await updateEmailAction(null, f)).toEqual({ notice: 'portal.email.sent' });
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { to: string[]; subject: string; text: string; sealed: Record<string, string> };
    expect(payload.to).toEqual([EMAIL]);
    expect(payload.subject).toBe('Verify your email for Acme Remit');
    expect(payload.text).toBe('{{verify_body}}');
    expect(JSON.stringify(payload.sealed)).not.toContain('smartremit.ai');
    expect(renderSealedText(payload.text, payload.sealed)).toMatch(/https:\/\/acme\.smartremit\.ai\/portal\/notifications\/verify\?token=[A-Za-z0-9_-]{43}/);
    expect(h.pokes).toBe(1);
    const after = await row('pa');
    const { emailEnc: _a, updatedAt: _b, ...restAfter } = after;
    const { emailEnc: _c, updatedAt: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore); // KYC, consent, MFA columns untouched
    expect(await getPortalPrefs(db, 'pa', phone)).toMatchObject({ emailVerifiedAt: null, emailVerifiedTag: null });
    const aud = await audits('customer.email.update');
    expect(aud).toHaveLength(1);
    expect(JSON.stringify(aud)).not.toContain(EMAIL);
    expect((await row('pb')).emailEnc).toBeNull();
  });

  it('rate-limited: 5 changes an hour per customer', async () => {
    for (let i = 0; i < 5; i++) expect(await updateEmailAction(null, emailFd())).toEqual({ notice: 'portal.email.sent' });
    expect(await updateEmailAction(null, emailFd())).toEqual({ error: 'portal.email.rate_limited' });
    expect(await emailRows()).toHaveLength(5);
  });

  it('a malformed request key → the expired copy, nothing sent', async () => {
    expect(await updateEmailAction(null, emailFd(EMAIL, 'bad'))).toEqual({ error: 'portal.action.expired' });
    expect(await emailRows()).toHaveLength(0);
  });
});

describe('verify link', () => {
  async function changeAndGetToken(email = EMAIL): Promise<string> {
    await updateEmailAction(null, emailFd(email));
    await signIn('pa'); // the next request loads the row with the new address
    return lastToken();
  }

  it('GET renders a confirm form and never consumes; the POST verifies once', async () => {
    const token = await changeAndGetToken();
    const html = renderToStaticMarkup(await VerifyEmailPage({ searchParams: Promise.resolve({ token }) }));
    expect(html).toContain('Confirm my email');
    expect(html).toContain(`value="${token}"`);
    renderToStaticMarkup(await VerifyEmailPage({ searchParams: Promise.resolve({ token }) }));
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ notice: 'portal.email.verified' });
    expect(await getPortalPrefs(db, 'pa', phone)).toMatchObject({ emailVerifiedTag: emailVerifiedTag('pa', phone, EMAIL) });
    expect(await audits('customer.email.verified')).toHaveLength(1);
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ error: 'portal.email.link_invalid' });
  });

  it('signed out: no form, no token in the page, a sign-in prompt; a malformed token → the one invalid message', async () => {
    const token = await changeAndGetToken();
    h.ctx = null;
    const html = renderToStaticMarkup(await VerifyEmailPage({ searchParams: Promise.resolve({ token }) }));
    expect(html).not.toContain(token);
    expect(html).toContain('Sign in first');
    await signIn('pa');
    const bad = renderToStaticMarkup(await VerifyEmailPage({ searchParams: Promise.resolve({ token: 'x' }) }));
    expect(bad).toContain('This link is not valid');
  });

  it("a token for an OLD address fails after a change (and the new one works)", async () => {
    const oldToken = await changeAndGetToken('old@example.com');
    const newToken = await changeAndGetToken('new@example.com');
    expect(await verifyEmailAction(null, fd({ token: oldToken }))).toEqual({ error: 'portal.email.link_invalid' });
    expect(await verifyEmailAction(null, fd({ token: newToken }))).toEqual({ notice: 'portal.email.verified' });
  });

  it('email receipts: refused until verified, then on/off (audited); turning off is always allowed', async () => {
    expect(await setEmailReceiptsAction(null, fd({ on: '1' }))).toEqual({ error: 'portal.receipt.verify_email_first' });
    const token = await changeAndGetToken();
    expect(await setEmailReceiptsAction(null, fd({ on: '1' }))).toEqual({ error: 'portal.receipt.verify_email_first' });
    await verifyEmailAction(null, fd({ token }));
    expect(await setEmailReceiptsAction(null, fd({ on: '1' }))).toEqual({ notice: 'portal.notify.receipts_on' });
    expect((await getPortalPrefs(db, 'pa', phone))?.emailReceipts).toBe(true);
    expect(await setEmailReceiptsAction(null, fd({ on: '0' }))).toEqual({ notice: 'portal.notify.receipts_off' });
    expect((await audits('customer.email.receipts')).map((r) => r.meta)).toEqual([{ on: true }, { on: false }]);
    expect(await getPortalPrefs(db, 'pb', phone)).toBeNull();
  });
});

describe('Notifications page', () => {
  it('masked address, verify state, WhatsApp state; receipts toggle only once verified; one pii.view when an address shows', async () => {
    let html = renderToStaticMarkup(await NotificationsPage());
    expect(html).toContain('No email address yet.');
    expect(html).toContain('Add and verify your email address above');
    expect(await audits('pii.view')).toHaveLength(0);
    await updateEmailAction(null, emailFd());
    await signIn('pa');
    const token = await lastToken();
    html = renderToStaticMarkup(await NotificationsPage());
    expect(html).not.toContain(EMAIL);
    expect(html).toContain('a•••@example.com');
    expect(html).toContain('Not verified');
    await verifyEmailAction(null, fd({ token }));
    html = renderToStaticMarkup(await NotificationsPage());
    expect(html).toContain('Turn on email receipts');
    expect(html).toContain('Turn off WhatsApp updates');
    expect((await audits('pii.view')).map((r) => r.meta)).toEqual([
      { fields: ['email'], by: 'customer', via: 'portal.notifications' },
      { fields: ['email'], by: 'customer', via: 'portal.notifications' },
    ]);
  });
});
