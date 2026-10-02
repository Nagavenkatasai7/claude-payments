import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Merge plan 2e: /partner/support/[ticketId] assign + escalate. Real gate (requirePartnerStaff over
// the real auth store on a fake Redis), real ticket/audit repos on PGlite. Each action runs the
// shared contract (expectPartnerActionContract) plus its own cases: the assignee must be a member of
// the SESSION tenant, an agent never assigns, the write and its ONE audit row commit together, and a
// repeat writes nothing.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
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

import { createAuthStore } from '@/lib/auth-store';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { auditEvents, outbox, tickets, ticketMessages } from '@/db/schema';
import { assignAction, escalateAction } from '@/app/partner/(app)/support/[ticketId]/actions';

const PHONE = '15557654321';
const NOT_FOUND = { ok: false, error: 'We could not find that ticket.' };
const REASON = 'Customer reports the payout has not arrived';
const PERMS = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function saveStaff(o: Partial<Staff> & { username: string }): Promise<void> {
  await createAuthStore(redis).saveStaff({ name: 'N', role: 'support', permissions: PERMS, passwordHash: 'x', createdAt: new Date().toISOString(), ...o } as Staff);
}

async function seedTicket(id: string, partnerId: string, o: { kind?: 'customer' | 'internal'; assignedTo?: string } = {}) {
  const repo = createTicketRepo(db);
  await repo.createTicket({
    id,
    partnerId,
    kind: o.kind ?? 'customer',
    customerPhone: o.kind === 'internal' ? undefined : PHONE,
    openedBy: o.kind === 'internal' ? 'contract-allowed' : undefined,
    subject: `subject ${id}`,
    body: `first message ${id}`,
  });
  if (o.assignedTo) await repo.assign(id, o.assignedTo);
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const audits = () => db.select().from(auditEvents);
const ticketRow = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0];
const messages = (id: string) => db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id));
const snapshot = async () => ({
  t: (await db.select().from(tickets)).map((r) => [r.id, r.status, r.assignedTo]).sort(),
  m: (await db.select().from(ticketMessages)).length,
  a: (await audits()).length,
});
const signIn = (o: Partial<Staff>) => signInAs(redis, cookieJar, { partnerId: 'pa', ...o });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await saveStaff({ username: 'pa-sup', partnerId: 'pa', role: 'support' });
  await saveStaff({ username: 'pa-agent', partnerId: 'pa', role: 'agent' });
  await saveStaff({ username: 'pa-fin', partnerId: 'pa', role: 'finance' as Staff['role'] });
  await saveStaff({ username: 'pa-gone', partnerId: 'pa', role: 'agent', status: 'suspended' });
  await saveStaff({ username: 'pb-sup', partnerId: 'pb', role: 'support' });
  await saveStaff({ username: 'plat-ops', partnerId: undefined, role: 'support' });
  await seedTicket('tk_a1', 'pa');
  await seedTicket('tk_a2', 'pa', { assignedTo: 'pa-agent' });
  await seedTicket('tk_b1', 'pb');
  await seedTicket('tk_ai', 'pa', { kind: 'internal' });
  vi.clearAllMocks();
});

describe('assignAction', () => {
  it('passes the shared /partner action contract (support allowed, agent bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: assignAction,
      form: (id) => form({ id, assignee: 'pa-sup' }),
      ownId: 'tk_a1',
      foreignId: 'tk_b1',
      allowedRole: 'support',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await ticketRow('tk_a1')).assignedTo).toBe('pa-sup');
  });

  it('refuses on a partner-site host before anything else', async () => {
    await signIn({ role: 'admin' });
    host.value = 'acme.smartremit.ai';
    await expect(assignAction(form({ id: 'tk_a1', assignee: 'pa-sup' }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await audits()).toHaveLength(0);
  });

  it('an agent never assigns, even a ticket assigned to them', async () => {
    await signIn({ username: 'pa-agent', role: 'agent' });
    const before = await snapshot();
    await expect(assignAction(form({ id: 'tk_a2', assignee: 'pa-sup' }))).rejects.toThrow('REDIRECT:/partner');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['another tenant’s member', 'pb-sup'],
    ['a SmartRemit platform account', 'plat-ops'],
    ['a finance member', 'pa-fin'],
    ['a suspended member', 'pa-gone'],
    ['an unknown username', 'nobody-here'],
  ])('refuses %s as the assignee, with one fixed message and no write', async (_label, assignee) => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const before = await snapshot();
    const r = await assignAction(form({ id: 'tk_a1', assignee }));
    expect(r).toEqual({ ok: false, error: 'Choose someone from your team who can work support requests.' });
    expect(JSON.stringify(r)).not.toContain(assignee);
    expect(await snapshot()).toEqual(before);
  });

  it('assigns an agent of the tenant, writing exactly one audit row in the session tenant', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await assignAction(form({ id: 'tk_a1', assignee: 'pa-agent' }))).toEqual({ ok: true });
    expect((await ticketRow('tk_a1')).assignedTo).toBe('pa-agent');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'ticket.assign', subjectId: 'tk_a1' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner', assignee: 'pa-agent' });
  });

  it('a repeat (or the same assignee again) writes nothing more', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const fd = form({ id: 'tk_a1', assignee: 'pa-sup' });
    expect(await assignAction(fd)).toEqual({ ok: true });
    expect(await assignAction(fd)).toEqual({ ok: true });
    expect(await audits()).toHaveLength(1);
  });

  it('an empty assignee unassigns (audited once)', async () => {
    await signIn({ username: 'pa-sup', role: 'support' });
    expect(await assignAction(form({ id: 'tk_a2', assignee: '' }))).toEqual({ ok: true });
    expect((await ticketRow('tk_a2')).assignedTo).toBeNull();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ actorScope: 'partner', assignee: null });
  });

  it('a Contact SmartRemit thread, a malformed id or a closed ticket is refused with no write', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await assignAction(form({ id: 'tk_ai', assignee: 'pa-sup' }))).toEqual(NOT_FOUND);
    expect(await assignAction(form({ id: '../tk_a1', assignee: 'pa-sup' }))).toEqual(NOT_FOUND);
    await createTicketRepo(db).updateStatus('tk_a1', 'closed');
    expect((await assignAction(form({ id: 'tk_a1', assignee: 'pa-sup' }))).ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('a malformed assignee value is refused', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect((await assignAction(form({ id: 'tk_a1', assignee: 'x'.repeat(200) }))).ok).toBe(false);
    expect((await assignAction(form({ id: 'tk_a1' }))).ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
});

describe('escalateAction', () => {
  it('passes the shared /partner action contract (admin allowed, finance bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: escalateAction,
      form: (id) => form({ id, reason: REASON }),
      ownId: 'tk_a1',
      foreignId: 'tk_b1',
      allowedRole: 'admin',
      disallowedRole: 'finance' as Staff['role'],
      snapshot,
    });
    expect((await ticketRow('tk_a1')).status).toBe('waiting_admin');
  });

  it('escalates: waiting_admin + one internal system note + one audit row, no customer nudge', async () => {
    await signIn({ username: 'pa-sup', role: 'support' });
    expect(await escalateAction(form({ id: 'tk_a1', reason: REASON }))).toEqual({ ok: true });
    expect((await ticketRow('tk_a1')).status).toBe('waiting_admin');
    const notes = await createTicketRepo(db).listMessages('tk_a1', { includeInternal: true });
    const note = notes.find((m) => m.actorType === 'system');
    expect(note).toMatchObject({ internal: true, body: `Escalated to SmartRemit: ${REASON}` });
    expect((await createTicketRepo(db).listMessages('tk_a1', { includeInternal: false })).some((m) => m.actorType === 'system')).toBe(false);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-sup', action: 'ticket.escalate', subjectId: 'tk_a1' });
    // The reason stays in the sealed note, never the append-only audit meta.
    expect(rows[0].meta).toEqual({ actorScope: 'partner', from: 'open' });
    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it('a repeat is refused and writes nothing more (audit row written once)', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await escalateAction(form({ id: 'tk_a1', reason: REASON }))).toEqual({ ok: true });
    expect(await escalateAction(form({ id: 'tk_a1', reason: REASON }))).toEqual({ ok: false, error: 'This request is already with SmartRemit.' });
    expect(await audits()).toHaveLength(1);
    expect((await messages('tk_a1')).length).toBe(2);
  });

  it('an agent escalates only a ticket assigned to them (else the same not found)', async () => {
    await signIn({ username: 'pa-agent', role: 'agent' });
    expect(await escalateAction(form({ id: 'tk_a1', reason: REASON }))).toEqual(NOT_FOUND);
    expect(await escalateAction(form({ id: 'tk_a2', reason: REASON }))).toEqual({ ok: true });
    expect(await audits()).toHaveLength(1);
  });

  it('a short reason or one carrying a phone-length number is refused before any write', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const before = await snapshot();
    expect(await escalateAction(form({ id: 'tk_a1', reason: 'too short' }))).toEqual({ ok: false, error: 'Give a reason of at least 10 characters.' });
    const r = await escalateAction(form({ id: 'tk_a1', reason: 'Call them on 415 555 0101 please' }));
    expect(r).toEqual({ ok: false, error: 'Remove phone or account numbers from the reason.' });
    expect(await snapshot()).toEqual(before);
  });

  it('a closed ticket or a Contact SmartRemit thread is refused', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await escalateAction(form({ id: 'tk_ai', reason: REASON }))).toEqual(NOT_FOUND);
    await createTicketRepo(db).updateStatus('tk_a1', 'closed');
    expect((await escalateAction(form({ id: 'tk_a1', reason: REASON }))).ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
});
