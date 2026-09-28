import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';
import {
  CONTACT_SUBJECT_MAX,
  REPLY_MAX,
  canViewTicket,
  claimOnce,
  getTenantTicket,
  getVisibleTicket,
  isTicketId,
  listContactThreads,
  listTenantTickets,
  listVisibleCustomerTickets,
  parseContactBody,
  parseContactSubject,
  parsePartnerTicketStatus,
  parseStaffText,
  staffClaimKey,
} from '@/lib/partner-tickets';

// UI redesign M3-19: the tenant-scoped ticket reads for /partner/support. The repo's listTickets
// treats a missing partnerId as "every tenant" (the platform queue), so /partner never calls it
// directly: these wrappers REQUIRE the session tenant and put it in the SQL WHERE.
const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
let db: Db;

async function seedTicket(o: {
  id: string;
  partnerId: string;
  kind?: 'customer' | 'internal';
  assignedTo?: string;
  openedBy?: string;
  status?: 'open' | 'pending' | 'resolved' | 'closed';
}) {
  const repo = createTicketRepo(db);
  await repo.createTicket({
    id: o.id,
    partnerId: o.partnerId,
    kind: o.kind ?? 'customer',
    customerPhone: o.kind === 'internal' ? undefined : '15551234567',
    openedBy: o.kind === 'internal' ? (o.openedBy ?? 'a1') : undefined,
    subject: `subject ${o.id}`,
    body: `body ${o.id}`,
  });
  if (o.assignedTo) await repo.assign(o.id, o.assignedTo);
  if (o.status && o.status !== 'open') await repo.updateStatus(o.id, o.status);
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  await seedTicket({ id: 'tk_a1', partnerId: PA, assignedTo: 'ag1' });
  await seedTicket({ id: 'tk_a2', partnerId: PA, status: 'resolved' });
  await seedTicket({ id: 'tk_b1', partnerId: PB, assignedTo: 'ag1' });
  await seedTicket({ id: 'tk_ai', partnerId: PA, kind: 'internal', openedBy: 'sup1' });
  await seedTicket({ id: 'tk_ai2', partnerId: PA, kind: 'internal', openedBy: 'adm1' });
  await seedTicket({ id: 'tk_bi', partnerId: PB, kind: 'internal', openedBy: 'sup1' });
});

describe('listTenantTickets (19.1)', () => {
  it("lists only the given tenant's tickets, never another partner's", async () => {
    const ids = (await listTenantTickets(PA, { kind: 'customer' }, db)).map((t) => t.id).sort();
    expect(ids).toEqual(['tk_a1', 'tk_a2']);
    const all = (await listTenantTickets(PA, {}, db)).map((t) => t.partnerId);
    expect(new Set(all)).toEqual(new Set([PA]));
  });
  it('a missing partner id is a type error AND throws at runtime (never the all-tenant queue)', async () => {
    // @ts-expect-error the partner id is required
    await expect(listTenantTickets(undefined, {}, db)).rejects.toThrow();
    await expect(listTenantTickets('', {}, db)).rejects.toThrow();
    // @ts-expect-error opts cannot smuggle a tenant
    await expect(listTenantTickets(PA, { partnerId: PB }, db)).resolves.toSatisfy((r: { partnerId: string }[]) =>
      r.every((t) => t.partnerId === PA),
    );
  });
});

describe('getTenantTicket', () => {
  it('returns the ticket only inside its own tenant', async () => {
    expect((await getTenantTicket(PA, 'tk_a1', db))?.id).toBe('tk_a1');
    expect(await getTenantTicket(PA, 'tk_b1', db)).toBeNull();
    expect(await getTenantTicket(PA, 'nope', db)).toBeNull();
    await expect(getTenantTicket('', 'tk_a1', db)).rejects.toThrow();
  });
});

describe('canViewTicket (who works what, per the legacy rules)', () => {
  const cust = { kind: 'customer' as const, assignedTo: 'ag1', openedBy: undefined };
  const internal = { kind: 'internal' as const, assignedTo: undefined, openedBy: 'sup1' };
  it('customer tickets: admin and support see the tenant queue; an agent only tickets assigned to them', () => {
    expect(canViewTicket({ role: 'admin', username: 'x' }, cust)).toBe(true);
    expect(canViewTicket({ role: 'support', username: 'x' }, cust)).toBe(true);
    expect(canViewTicket({ role: 'agent', username: 'ag1' }, cust)).toBe(true);
    expect(canViewTicket({ role: 'agent', username: 'ag2' }, cust)).toBe(false);
    expect(canViewTicket({ role: 'agent', username: 'ag2' }, { ...cust, assignedTo: undefined })).toBe(false);
  });
  it('Contact SmartRemit threads: an admin sees the tenant threads; everyone else only their own', () => {
    expect(canViewTicket({ role: 'admin', username: 'x' }, internal)).toBe(true);
    expect(canViewTicket({ role: 'support', username: 'sup1' }, internal)).toBe(true);
    expect(canViewTicket({ role: 'support', username: 'sup2' }, internal)).toBe(false);
    expect(canViewTicket({ role: 'agent', username: 'sup2' }, internal)).toBe(false);
  });
  it('an unknown role sees nothing (fails closed)', () => {
    expect(canViewTicket({ role: 'finance' as never, username: 'x' }, cust)).toBe(false);
    expect(canViewTicket({ role: 'finance' as never, username: 'x' }, internal)).toBe(false);
  });
});

describe('getVisibleTicket / listVisibleCustomerTickets / listContactThreads', () => {
  const ctx = (role: 'admin' | 'agent' | 'support', username: string, partnerId = PA) => ({ role, username, partnerId });
  it("a crafted id from another tenant, or of the wrong kind, is a miss", async () => {
    expect(await getVisibleTicket(ctx('admin', 'adm1'), 'tk_b1', 'customer', db)).toBeNull();
    expect(await getVisibleTicket(ctx('admin', 'adm1'), 'tk_bi', 'internal', db)).toBeNull();
    expect(await getVisibleTicket(ctx('admin', 'adm1'), 'tk_ai', 'customer', db)).toBeNull();
    expect(await getVisibleTicket(ctx('admin', 'adm1'), 'tk_a1', 'internal', db)).toBeNull();
    expect((await getVisibleTicket(ctx('admin', 'adm1'), 'tk_a1', 'customer', db))?.id).toBe('tk_a1');
    expect(await getVisibleTicket(ctx('admin', 'adm1'), '../x', 'customer', db)).toBeNull();
  });
  it('the customer queue: an agent lists only their assigned tickets in the tenant', async () => {
    expect((await listVisibleCustomerTickets(ctx('agent', 'ag1'), {}, db)).map((t) => t.id)).toEqual(['tk_a1']);
    expect(await listVisibleCustomerTickets(ctx('agent', 'ag9'), {}, db)).toEqual([]);
    expect((await listVisibleCustomerTickets(ctx('support', 's'), {}, db)).map((t) => t.id).sort()).toEqual(['tk_a1', 'tk_a2']);
    expect((await listVisibleCustomerTickets(ctx('support', 's'), { status: 'resolved' }, db)).map((t) => t.id)).toEqual(['tk_a2']);
  });
  it("contact threads: never another tenant's; non-admins see only their own", async () => {
    expect((await listContactThreads(ctx('admin', 'adm1'), db)).map((t) => t.id).sort()).toEqual(['tk_ai', 'tk_ai2']);
    expect((await listContactThreads(ctx('support', 'sup1'), db)).map((t) => t.id)).toEqual(['tk_ai']);
    expect((await listContactThreads(ctx('agent', 'zz'), db)).map((t) => t.id)).toEqual([]);
    expect((await listContactThreads(ctx('support', 'sup1', PB), db)).map((t) => t.id)).toEqual(['tk_bi']);
  });
});

describe('input validation (refuse, never truncate)', () => {
  it('ticket ids', () => {
    expect(isTicketId('tk_AbC-12_x')).toBe(true);
    for (const bad of ['', ' ', '../x', 'a'.repeat(81), 'tk 1', 'tk_1?x', 42]) expect(isTicketId(bad), String(bad)).toBe(false);
  });
  it('staff text: trimmed, 1..REPLY_MAX, over-length refused', () => {
    expect(parseStaffText('  hi  ')).toBe('hi');
    expect(parseStaffText('   ')).toBeNull();
    expect(parseStaffText(null)).toBeNull();
    expect(parseStaffText('x'.repeat(REPLY_MAX))).toHaveLength(REPLY_MAX);
    expect(parseStaffText('x'.repeat(REPLY_MAX + 1))).toBeNull();
  });
  it('contact subject and body', () => {
    expect(parseContactSubject('ab')).toBeNull();
    expect(parseContactSubject('abc')).toBe('abc');
    expect(parseContactSubject('x'.repeat(CONTACT_SUBJECT_MAX + 1))).toBeNull();
    expect(parseContactBody('too short')).toBeNull();
    expect(parseContactBody('long enough body')).toBe('long enough body');
    expect(parseContactBody('x'.repeat(2001))).toBeNull();
  });
  it('status allowlist: waiting_admin and junk are refused', () => {
    for (const s of ['open', 'pending', 'resolved', 'closed']) expect(parsePartnerTicketStatus(s)).toBe(s);
    for (const s of ['waiting_admin', '', 'OPEN', null, 'deleted']) expect(parsePartnerTicketStatus(s)).toBeNull();
  });
});

describe('claimOnce (double-submit guard for staff writes)', () => {
  const KEY = 'a'.repeat(32);
  it('the key is bound to the tenant, the user, the scope and the request key; no raw input in it', () => {
    const k = staffClaimKey('reply', PA, 'u1', KEY, 'tk_a1|hello');
    expect(k).not.toBe(staffClaimKey('reply', PB, 'u1', KEY, 'tk_a1|hello'));
    expect(k).not.toBe(staffClaimKey('reply', PA, 'u2', KEY, 'tk_a1|hello'));
    expect(k).not.toBe(staffClaimKey('note', PA, 'u1', KEY, 'tk_a1|hello'));
    // Bound to the target and the text: the same key on another ticket or text is a new request.
    expect(k).not.toBe(staffClaimKey('reply', PA, 'u1', KEY, 'tk_a2|hello'));
    expect(k).not.toBe(staffClaimKey('reply', PA, 'u1', KEY, 'tk_a1|other'));
    expect(k).not.toContain('hello');
    expect(k).not.toContain(PA);
    expect(k).not.toContain(KEY);
  });
  it('runs once; a replay after success reports done with the stored value and never re-runs', async () => {
    const redis = fakeRedis();
    let runs = 0;
    const fn = async () => {
      runs++;
      return 'tk_new';
    };
    expect(await claimOnce(redis, 'k1', fn)).toEqual({ status: 'ran', value: 'tk_new' });
    expect(await claimOnce(redis, 'k1', fn)).toEqual({ status: 'replay', value: 'tk_new' });
    expect(runs).toBe(1);
  });
  it('a replay while the first run is in flight is reported as in flight', async () => {
    const redis = fakeRedis();
    await redis.set('k2', 'p', { nx: true, ex: 60 });
    expect(await claimOnce(redis, 'k2', async () => 'x')).toEqual({ status: 'inflight' });
  });
  it('a failed run releases the claim so an honest retry runs', async () => {
    const redis = fakeRedis();
    await expect(claimOnce(redis, 'k3', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await claimOnce(redis, 'k3', async () => 'ok')).toEqual({ status: 'ran', value: 'ok' });
  });
});

describe('tenantStaffUsernames (who is shown by name)', () => {
  it('names only active members of THIS tenant; platform staff, other tenants and unknown names are not', async () => {
    const { tenantStaffUsernames } = await import('@/lib/partner-tickets');
    const people: Record<string, { partnerId?: string } | null> = {
      mine: { partnerId: PA },
      platform: {},
      other: { partnerId: PB },
    };
    const lookups: string[] = [];
    const getStaff = async (u: string) => {
      lookups.push(u);
      return people[u] ?? null;
    };
    const names = await tenantStaffUsernames(PA, ['mine', 'platform', 'other', 'ghost', 'mine', ''], getStaff);
    expect([...names]).toEqual(['mine']);
    expect(lookups.sort()).toEqual(['ghost', 'mine', 'other', 'platform']);
  });
  it('a failed lookup names nobody (never throws the page)', async () => {
    const { tenantStaffUsernames } = await import('@/lib/partner-tickets');
    const names = await tenantStaffUsernames(PA, ['mine'], async () => Promise.reject(new Error('down')));
    expect(names.size).toBe(0);
  });
});
