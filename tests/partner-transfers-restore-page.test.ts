import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// Lost-features restore p1 B1 / B2: the transfer list's sealed search, date range, "assigned to
// me" and the extra columns. The search text never reaches a URL; name / phone search is for admin
// and agent only (review 2.7); every column is a closed label or a masked value.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;

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
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});

import ListPage from '@/app/partner/(app)/transfers/page';
import DetailPage from '@/app/partner/(app)/transfers/[id]/page';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import { searchTransfersAction } from '@/app/partner/(app)/transfers/search-actions';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { sealTransferSearch } from '@/lib/partner-transfer-search';

const PHONE = '14155550101';
const list = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve(sp) }));
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
const asAgent = () => signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
const detail = async (id: string) => renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
const enroll = (u: string) => redis.set(staffMfaKeys.secret(u), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
const asFinance = () => signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' });
const tok = (q: Parameters<typeof sealTransferSearch>[2], user = 'pa-admin', partner = 'pa') => sealTransferSearch(partner, user, q, Date.now());
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error('no redirect');
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A_asha', partnerId: 'pa', phone: PHONE, recipientName: 'Asha Rao', status: 'awaiting_payment', createdAt: '2026-09-01T10:00:00.000Z', assignedTo: 'pa-agent' });
  await seedPartnerTransfer(db, { id: 'tr_A_meera', partnerId: 'pa', phone: '447700900123', recipientName: 'Meera Iyer', createdAt: '2026-09-05T10:00:00.000Z', assignedTo: 'platform-ops', status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
  await seedPartnerTransfer(db, { id: 'tr_B_asha', partnerId: 'pb', phone: PHONE, recipientName: 'Asha Rao', createdAt: '2026-09-01T11:00:00.000Z' });
  await createCustomerRepo(db, async () => null).ensureCustomer('pa', PHONE);
  await db.execute(sql`UPDATE customers SET kyc_status = 'verified' WHERE partner_id = 'pa'`);
  await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
});

describe('searchTransfersAction', () => {
  it('admin / agent: a name or phone becomes a sealed token; the text is never in the URL', async () => {
    await asAdmin();
    const to = await redirectOf(searchTransfersAction(form({ q: '+1 (415) 555-0101', status: 'awaiting_payment', from: '2026-09-01', mine: '1' })));
    expect(to).toMatch(/^\/partner\/transfers\?status=awaiting_payment&s=[A-Za-z0-9._-]+&from=2026-09-01&mine=1$/);
    expect(to).not.toContain('5550101');
    const name = await redirectOf(searchTransfersAction(form({ q: 'Asha' })));
    expect(name).not.toContain('Asha');
    expect(name).toMatch(/[?&]s=/);
  });
  it('junk is refused with bad=1; an empty search keeps the closed filters only', async () => {
    await asAgent();
    expect(await redirectOf(searchTransfersAction(form({ q: '12' })))).toBe('/partner/transfers?bad=1');
    expect(await redirectOf(searchTransfersAction(form({ q: '', environment: 'test', partnerId: 'pb' })))).toBe('/partner/transfers?environment=test');
  });
  it('finance: a transfer id only (plain q); a name or phone is refused, never sealed', async () => {
    await asFinance();
    expect(await redirectOf(searchTransfersAction(form({ q: 'tr_A_asha' })))).toBe('/partner/transfers?q=tr_A_asha');
    expect(await redirectOf(searchTransfersAction(form({ q: '14155550101' })))).toBe('/partner/transfers?bad=1');
    expect(await redirectOf(searchTransfersAction(form({ q: 'Asha Rao' })))).toBe('/partner/transfers?bad=1');
    expect(await redirectOf(searchTransfersAction(form({ q: 'tr_A_asha', mine: '1' })))).toBe('/partner/transfers?q=tr_A_asha');
  });
  it('the gate: support is bounced', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-sup', partnerId: 'pa', role: 'support' });
    expect(await redirectOf(searchTransfersAction(form({ q: 'Asha' })))).toBe('/partner');
  });
});

describe('/partner/transfers: sealed search', () => {
  it('a name search finds this tenant only; the term is never in an href', async () => {
    await asAdmin();
    const s = tok({ kind: 'text', value: 'Asha' });
    const html = await list({ s });
    expect(html).toContain('data-row="tr_A_asha"');
    expect(html).not.toContain('tr_A_meera');
    expect(html).not.toContain('tr_B_asha');
    for (const href of html.match(/href="[^"]*"/g) ?? []) expect(href).not.toMatch(/Asha|5550101/);
  });
  it('a phone suffix search', async () => {
    await asAgent();
    const html = await list({ s: tok({ kind: 'digits', value: '4155550101' }, 'pa-agent') });
    expect(html).toContain('data-row="tr_A_asha"');
    expect(html).not.toContain('data-row="tr_A_meera"');
  });
  it("a token for another user or tenant is ignored and reads as expired", async () => {
    await asAdmin();
    for (const s of [tok({ kind: 'text', value: 'Asha' }, 'pa-agent'), tok({ kind: 'text', value: 'Asha' }, 'pa-admin', 'pb'), 'v1.a.b.c.d']) {
      const html = await list({ s });
      expect(html).toContain('Your search expired. Search again.');
      expect(html).toContain('data-row="tr_A_meera"'); // the unfiltered list
    }
  });
  it('finance never opens a token, even its own', async () => {
    await asFinance();
    const html = await list({ s: tok({ kind: 'text', value: 'Asha' }, 'pa-fin') });
    expect(html).toContain('data-row="tr_A_meera"');
    expect(html).toContain('Your search expired');
  });
  it('the pager keeps the token', async () => {
    await asAdmin();
    for (let i = 0; i < 26; i++) {
      await seedPartnerTransfer(db, { id: `tr_A_bulk${String(i).padStart(2, '0')}`, partnerId: 'pa', recipientName: 'Asha Bulk', createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString() });
    }
    const s = tok({ kind: 'text', value: 'Asha' });
    const html = await list({ s });
    expect(html).toContain(`s=${s}`);
  });
});

describe('/partner/transfers: dates and mine', () => {
  it('a date range filters by UTC day', async () => {
    await asAdmin();
    const html = await list({ from: '2026-09-04', to: '2026-09-05' });
    expect(html).toContain('data-row="tr_A_meera"');
    expect(html).not.toContain('data-row="tr_A_asha"');
  });
  it('mine=1 lists what is assigned to the viewer (admin and agent only)', async () => {
    await asAgent();
    const html = await list({ mine: '1' });
    expect(html).toContain('data-row="tr_A_asha"');
    expect(html).not.toContain('data-row="tr_A_meera"');
    await asFinance();
    const fin = await list({ mine: '1' });
    expect(fin).toContain('data-row="tr_A_meera"');
    expect(fin).not.toContain('name="mine"');
  });
});

describe('/partner/transfers: columns', () => {
  it('sender masked, route, tier, KYC, funding, compliance; a tenant assignee by name and anyone else as SmartRemit', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    const html = await list();
    expect(html).toContain('••••0101');
    expect(html).toContain('US → IN');
    expect(html).toContain('Verified');
    expect(html).toContain('Bank transfer');
    expect(html).toContain('Held');
    expect(html).toContain('pa-agent');
    expect(html).not.toContain('platform-ops');
    expect(html).toContain('SmartRemit');
    expect(html).not.toContain(PHONE);
  });
  it('the customer link: admin and agent only, sealed, never prefetched', async () => {
    await asAdmin();
    const html = await list();
    const m = /<a[^>]*href="(\/partner\/customers\/[^"]+)"[^>]*>Open customer<\/a>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain(PHONE);
    expect(m![0]).not.toContain('5550101');
    await asFinance();
    expect(await list()).not.toContain('Open customer');
  });
  it('rendering writes no audit row', async () => {
    await asAdmin();
    const n = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
    const before = await n();
    await list({ s: tok({ kind: 'text', value: 'Asha' }) });
    expect(await n()).toBe(before);
  });
});

describe('/partner/transfers/[id]: B3 detail fields and reveals', () => {
  const SHOW = /aria-label="Show ([^"]+)"/g;
  const shows = (html: string) => [...html.matchAll(SHOW)].map((m) => m[1]).sort();
  it('an enrolled admin gets every Show control; the page stays masked and writes no audit row', async () => {
    await asAdmin();
    await enroll('pa-admin');
    const html = await detail('tr_A_asha');
    expect(shows(html)).toEqual(['Paid to', 'Recipient name', 'Recipient phone', 'Sender name', 'Sender phone']);
    expect(html).not.toContain(PHONE);
    expect(html).not.toContain('Asha Rao');
    expect(html).toContain('Asha R.');
    expect(html).toContain('Revealing a value is recorded in your audit log');
    const n = ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
    expect(n).toBe(0);
  });
  it('an enrolled agent without canRevealPii: identity only, with the permission hint', async () => {
    await asAgent();
    await enroll('pa-agent');
    const html = await detail('tr_A_asha');
    expect(shows(html)).toEqual(['Recipient name', 'Recipient phone', 'Sender name', 'Sender phone']);
    expect(html).toContain('Ask SmartRemit for the reveal permission');
  });
  it('not enrolled: no Show control, with the two-step hint; finance: none and no hint', async () => {
    await asAgent();
    const html = await detail('tr_A_asha');
    expect(shows(html)).toEqual([]);
    expect(html).toContain('Turn on two-step verification');
    await asFinance();
    await enroll('pa-fin');
    const fin = await detail('tr_A_asha');
    expect(shows(fin)).toEqual([]);
    expect(fin).not.toContain('Turn on two-step verification');
    expect(fin).not.toContain('Open customer');
  });
  it('no customer row (another sender): no sender-name row and no customer link', async () => {
    await asAdmin();
    await enroll('pa-admin');
    const html = await detail('tr_A_meera');
    expect(html).not.toContain('Sender name');
    expect(html).not.toContain('Open customer');
  });
  it('the route by class only, and the assignee (own staff by name, anyone else as SmartRemit)', async () => {
    await asAdmin();
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    await asAdmin();
    await db.execute(sql`UPDATE transfers SET settlement_partner_id = 'pb' WHERE id = 'tr_A_meera'`);
    const routed = await detail('tr_A_meera');
    expect(routed).toContain('A SmartRemit network partner (best rate)');
    expect(routed).not.toContain('Partner B');
    expect(routed).not.toMatch(/>pb</);
    expect(routed).not.toContain('platform-ops');
    expect(await detail('tr_A_asha')).toContain('Your settlement rail');
    expect(await detail('tr_A_asha')).toContain('pa-agent');
  });
});

describe('/partner/transfers/[id]: A2 assign control', () => {
  it('admin: the picker lists this tenant\'s admins and agents only', async () => {
    await signInAs(redis, cookieJar, { username: 'pb-agent', partnerId: 'pb', role: 'agent' });
    await signInAs(redis, cookieJar, { username: 'plat-admin', role: 'admin' });
    await signInAs(redis, cookieJar, { username: 'pa-sup', partnerId: 'pa', role: 'support' });
    await asAdmin();
    const html = await detail('tr_A_asha');
    expect(html).toContain('data-testid="partner-assign-form"');
    const opts = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(opts).toEqual(expect.arrayContaining(['', 'pa-admin', 'pa-agent']));
    expect(opts).not.toContain('pb-agent');
    expect(opts).not.toContain('plat-admin');
    expect(opts).not.toContain('pa-sup');
  });
  it('an agent without canAssign: no form, and the permission hint; with it: the form', async () => {
    await asAgent();
    const html = await detail('tr_A_asha');
    expect(html).not.toContain('partner-assign-form');
    expect(html).toContain('Ask your admin or SmartRemit');
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent', permissions: { canCancel: true, canAssign: true, canResend: true, canRevealPii: false } });
    const ok = await detail('tr_A_asha');
    expect(ok).toContain('partner-assign-form');
    expect(ok).not.toContain('Ask your admin or SmartRemit');
  });
  it('finance: no actions section', async () => {
    await asFinance();
    expect(await detail('tr_A_asha')).not.toContain('partner-assign-form');
  });
});
