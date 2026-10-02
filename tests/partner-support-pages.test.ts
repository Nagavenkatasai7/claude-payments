import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-19: the /partner/support pages. Real gate + real repos on PGlite. Tenant isolation
// by crafted ids, the agent assignee rule, masked customer identity (no full phone anywhere, not
// even the customer's message author id), staff-only notes shown only to staff with a badge,
// platform usernames never named, and the loading/empty/error states.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const fail = { list: false };
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
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/partner-tickets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-tickets')>('@/lib/partner-tickets');
  return {
    ...actual,
    listVisibleCustomerTickets: (...a: Parameters<typeof actual.listVisibleCustomerTickets>) =>
      fail.list ? Promise.reject(new Error('db down 15559990000')) : actual.listVisibleCustomerTickets(...a),
    listContactThreads: (...a: Parameters<typeof actual.listContactThreads>) =>
      fail.list ? Promise.reject(new Error('db down')) : actual.listContactThreads(...a),
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import SupportPage from '@/app/partner/(app)/support/page';
import TicketPage from '@/app/partner/(app)/support/[ticketId]/page';
import ContactPage from '@/app/partner/(app)/support/contact/page';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const PHONE_A = '15557654321';
const PHONE_B = '15550001111';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const FINANCE_REDIRECT = (KNOWN_PARTNER_ROLES as readonly string[]).includes('finance') ? 'REDIRECT:/partner' : 'REDIRECT:/login';

async function saveStaff(o: Partial<Staff>): Promise<Staff> {
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    partnerId: PA,
    ...o,
  };
  await getAuthStore().saveStaff(s);
  return s;
}
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s = await saveStaff(o);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}

const list = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await SupportPage({ searchParams: Promise.resolve(sp) }));
const ticket = async (id: string) => renderToStaticMarkup(await TicketPage({ params: Promise.resolve({ ticketId: id }) }));
const contact = async () => renderToStaticMarkup(await ContactPage());

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  fail.list = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  const repo = createTicketRepo(db);
  await repo.createTicket({ id: 'tk_a1', partnerId: PA, kind: 'customer', customerPhone: PHONE_A, subject: 'Where is my money', body: 'Sent yesterday, not arrived' });
  await repo.assign('tk_a1', 'ag1');
  await repo.appendMessage({ ticketId: 'tk_a1', actorType: 'staff', actorId: 'platformbob', body: 'Looking into it', internal: false });
  await repo.appendMessage({ ticketId: 'tk_a1', actorType: 'staff', actorId: 'sup1', body: 'Rail delay noted', internal: true });
  await repo.createTicket({ id: 'tk_a2', partnerId: PA, kind: 'customer', customerPhone: PHONE_A, subject: 'Change recipient', body: 'Please change it' });
  await repo.updateStatus('tk_a2', 'resolved');
  await repo.createTicket({ id: 'tk_b1', partnerId: PB, kind: 'customer', customerPhone: PHONE_B, subject: 'Bravo secret subject', body: 'bravo body' });
  await repo.assign('tk_b1', 'ag1');
  await repo.createTicket({ id: 'tk_ai', partnerId: PA, kind: 'internal', openedBy: 'sup1', subject: 'Alpha question to platform', body: 'How do we rotate keys?' });
  await repo.appendMessage({ ticketId: 'tk_ai', actorType: 'staff', actorId: 'platformbob', body: 'Use the integrations page', internal: false });
  await repo.createTicket({ id: 'tk_bi', partnerId: PB, kind: 'internal', openedBy: 'sup1', subject: 'Bravo question to platform', body: 'bravo internal' });
  // Staff records: sup1 and ag1 are Alpha's; platformbob is SmartRemit's (no partnerId).
  await saveStaff({ username: 'sup1', role: 'support' });
  await saveStaff({ username: 'ag1', role: 'agent' });
  await saveStaff({ username: 'platformbob', role: 'agent', partnerId: undefined });
});

describe('gates (each page re-gates; the layout is not the guard)', () => {
  it('anonymous → /login; platform → /admin-dashboard; finance bounced', async () => {
    for (const render of [() => list(), () => ticket('tk_a1'), () => contact()]) {
      cookieJar.clear();
      await expect(render()).rejects.toThrow('REDIRECT:/login');
      await signInAs({ username: 'plat', partnerId: undefined });
      await expect(render()).rejects.toThrow('REDIRECT:/admin-dashboard');
      await signInAs({ username: 'fin', role: 'finance' as Staff['role'] });
      await expect(render()).rejects.toThrow(FINANCE_REDIRECT);
    }
  });
});

describe('/partner/support (the tenant customer queue)', () => {
  it("lists only this tenant's customer tickets, masked; no full phone, no other tenant, no contact threads", async () => {
    await signInAs({ role: 'support', username: 'sup1' });
    const html = await list();
    expect(html).toContain('Where is my money');
    expect(html).toContain('Change recipient');
    expect(html).toContain('••••4321');
    expect(html).not.toContain(PHONE_A);
    expect(html).not.toContain('Bravo secret subject');
    expect(html).not.toContain('Alpha question to platform');
    expect(html).toContain('href="/partner/support/tk_a1"');
    expect(html).not.toContain('tk_b1');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<main\b/);
  });
  it('an agent sees only tickets assigned to them', async () => {
    await signInAs({ role: 'agent', username: 'ag1' });
    const html = await list();
    expect(html).toContain('Where is my money');
    expect(html).not.toContain('Change recipient');
    expect(html).not.toContain('Bravo secret subject');
  });
  it('the status filter is allowlisted (junk shows everything)', async () => {
    await signInAs({ role: 'admin' });
    const resolved = await list({ status: 'resolved' });
    expect(resolved).toContain('Change recipient');
    expect(resolved).not.toContain('Where is my money');
    const junk = await list({ status: "'; drop" });
    expect(junk).toContain('Where is my money');
    expect(junk).toContain('Change recipient');
  });
  it('empty state', async () => {
    await signInAs({ role: 'agent', username: 'nobody' });
    expect(await list()).toContain('No support requests');
  });
  it('a failed read shows the error state (no raw error text)', async () => {
    await signInAs({ role: 'admin' });
    fail.list = true;
    const html = await list();
    expect(html).toContain('Support requests could not be loaded');
    expect(html).not.toContain('15559990000');
  });
});

describe('/partner/support/[ticketId]', () => {
  it("a crafted id from another tenant is not found (both kinds), and a junk id too", async () => {
    await signInAs({ role: 'admin' });
    await expect(ticket('tk_b1')).rejects.toThrow('NOT_FOUND');
    await expect(ticket('tk_bi')).rejects.toThrow('NOT_FOUND');
    await expect(ticket('..%2Ftk_a1')).rejects.toThrow('NOT_FOUND');
  });
  it('an agent opening a ticket not assigned to them → not found', async () => {
    await signInAs({ role: 'agent', username: 'ag2' });
    await expect(ticket('tk_a1')).rejects.toThrow('NOT_FOUND');
  });
  it('a customer ticket: masked customer, staff-only note badged, platform staff unnamed, no phone anywhere', async () => {
    await signInAs({ role: 'support', username: 'sup1' });
    const html = await ticket('tk_a1');
    expect(html).toContain('Where is my money');
    expect(html).toContain('Sent yesterday, not arrived');
    expect(html).toContain('••••4321');
    expect(html).not.toContain(PHONE_A);
    // No 10+ digit run anywhere (the hex request keys are stripped first: they are random).
    expect(html.replace(/value="[0-9a-f]{32}"/g, '')).not.toMatch(/\d{10,}/);
    expect(html).toContain('Rail delay noted');
    expect(html).toContain('Internal note');
    expect(html).not.toContain('platformbob');
    expect(html).toContain('SmartRemit');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // The reply / note / status forms carry the id and a server-minted request key, never a tenant.
    expect(html).toContain('name="requestKey"');
    expect(html).not.toContain(PA);
  });
  it('a closed ticket is read-only', async () => {
    await createTicketRepo(db).updateStatus('tk_a1', 'closed');
    await signInAs({ role: 'admin' });
    const html = await ticket('tk_a1');
    expect(html).toContain('This request is closed');
    expect(html).not.toContain('name="body"');
  });
  it('a Contact SmartRemit thread: the opener can follow up; the platform reply is labelled SmartRemit', async () => {
    await signInAs({ role: 'support', username: 'sup1' });
    const html = await ticket('tk_ai');
    expect(html).toContain('Alpha question to platform');
    expect(html).toContain('Use the integrations page');
    expect(html).not.toContain('platformbob');
    expect(html).toContain('name="body"');
  });
  it('another support member cannot open a thread they did not start; an admin reads it without a reply box', async () => {
    await signInAs({ role: 'support', username: 'sup2' });
    await expect(ticket('tk_ai')).rejects.toThrow('NOT_FOUND');
    await signInAs({ role: 'admin', username: 'adm1' });
    const html = await ticket('tk_ai');
    expect(html).toContain('Alpha question to platform');
    expect(html).not.toContain('name="body"');
    expect(html).toContain('Only the person who started this conversation can add to it');
  });
});

describe('/partner/support/contact', () => {
  it("an admin lists the tenant's threads only; the form is present", async () => {
    await signInAs({ role: 'admin', username: 'adm1' });
    const html = await contact();
    expect(html).toContain('Alpha question to platform');
    expect(html).not.toContain('Bravo question to platform');
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="requestKey"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
  it('a support member lists only their own; empty state otherwise', async () => {
    await signInAs({ role: 'support', username: 'sup1' });
    expect(await contact()).toContain('Alpha question to platform');
    await signInAs({ role: 'support', username: 'sup2' });
    const html = await contact();
    expect(html).not.toContain('Alpha question to platform');
    expect(html).toContain('No conversations yet');
  });
  it('a failed read shows the error state', async () => {
    await signInAs({ role: 'admin' });
    fail.list = true;
    expect(await contact()).toContain('Conversations could not be loaded');
  });
});

describe("LOW-5: a partner pinned to the 'default' tenant never sees SmartRemit's internal questions", () => {
  beforeEach(async () => {
    // SmartRemit's own staff file their questions under 'default' (admin-dashboard/employee-questions).
    await createTicketRepo(db).createTicket({ id: 'tk_plat_q', partnerId: DEFAULT_PARTNER_ID, kind: 'internal', openedBy: 'platformbob', subject: 'Platform internal question', body: 'internal only' });
  });
  it('the contact list is empty for a default-tenant admin', async () => {
    await signInAs({ username: 'dadm', role: 'admin', partnerId: DEFAULT_PARTNER_ID });
    const html = await contact();
    expect(html).not.toContain('Platform internal question');
    expect(html).toContain('No conversations yet');
    // No form to start a thread: a short note instead.
    expect(html).not.toContain('name="subject"');
    expect(html).toContain('Contact SmartRemit is not available for this workspace.');
  });
  it('the support queue does not link to Contact SmartRemit', async () => {
    await signInAs({ username: 'dadm', role: 'admin', partnerId: DEFAULT_PARTNER_ID });
    expect(await list()).not.toContain('/partner/support/contact');
    await signInAs({ role: 'admin' });
    expect(await list()).toContain('/partner/support/contact');
  });
  it('opening the question by id is not found', async () => {
    await signInAs({ username: 'dadm', role: 'admin', partnerId: DEFAULT_PARTNER_ID });
    await expect(ticket('tk_plat_q')).rejects.toThrow('NOT_FOUND');
  });
});

describe('merge plan 2e: the "mine" filter, assign and escalate on the pages', () => {
  it('?mine=1 narrows an admin/support queue to their own tickets; the link is offered to them only', async () => {
    await createTicketRepo(db).assign('tk_a2', 'sup1');
    await signInAs({ role: 'support', username: 'sup1' });
    const all = await list();
    expect(all).toContain('href="/partner/support?mine=1"');
    const mine = await list({ mine: '1' });
    expect(mine).toContain('Change recipient');
    expect(mine).not.toContain('Where is my money');
    // The status links keep the filter.
    expect(mine).toContain('href="/partner/support?status=open&amp;mine=1"');
    await signInAs({ role: 'admin', username: 'adm1' });
    expect(await list({ mine: '1' })).toContain('No requests are assigned to you.');
    await signInAs({ role: 'agent', username: 'ag1' });
    const agent = await list({ mine: '1' });
    expect(agent).not.toContain('mine=1');
    expect(agent).toContain('Where is my money');
  });
  it('admin and support get the assign picker listing ONLY the tenant’s eligible staff', async () => {
    await saveStaff({ username: 'pb-sup', role: 'support', partnerId: PB });
    await saveStaff({ username: 'pa-fin', role: 'finance' as Staff['role'] });
    for (const role of ['admin', 'support'] as const) {
      await signInAs({ role, username: `lead-${role}` });
      const html = await ticket('tk_a1');
      expect(html).toContain('name="assignee"');
      expect(html).toContain('<option value="ag1" selected="">');
      expect(html).toContain('value="sup1"');
      expect(html).not.toContain('platformbob');
      expect(html).not.toContain('pb-sup');
      expect(html).not.toContain('pa-fin');
      expect(html).toContain('name="reason"');
    }
  });
  it('an agent gets no assign picker but may escalate their own ticket', async () => {
    await signInAs({ role: 'agent', username: 'ag1' });
    const html = await ticket('tk_a1');
    expect(html).not.toContain('name="assignee"');
    expect(html).toContain('name="reason"');
  });
  it('a ticket assigned to SmartRemit staff shows "SmartRemit", never the username', async () => {
    await createTicketRepo(db).assign('tk_a1', 'platformbob');
    await signInAs({ role: 'admin', username: 'adm1' });
    const html = await ticket('tk_a1');
    expect(html).toContain('Assigned to SmartRemit');
    expect(html).not.toContain('platformbob');
  });
  it('an escalated ticket shows a status line instead of the escalate form', async () => {
    await createTicketRepo(db).updateStatus('tk_a1', 'waiting_admin');
    await signInAs({ role: 'admin', username: 'adm1' });
    const html = await ticket('tk_a1');
    expect(html).toContain('This request is with SmartRemit.');
    expect(html).not.toContain('name="reason"');
  });
});

describe('LOW-4: an escalated (waiting_admin) ticket offers no partner status change', () => {
  it('the status form is not rendered', async () => {
    await signInAs({ role: 'admin' });
    expect(await ticket('tk_a1')).toContain('name="status"');
    await createTicketRepo(db).updateStatus('tk_a1', 'waiting_admin');
    const html = await ticket('tk_a1');
    expect(html).toContain('Escalated');
    expect(html).not.toContain('name="status"');
    // The reply form stays, without the "waiting on customer" box (that would move the status).
    expect(html).toContain('name="body"');
    expect(html).not.toContain('name="waiting"');
  });
});
