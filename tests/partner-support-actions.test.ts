import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-19: the /partner/support server actions. Real gate (requirePartnerStaff over the
// real auth store on a fake Redis, the partner store on PGlite), real ticket/audit/outbox repos.
// Each action runs the shared per-action checklist (M3 plan, "Shared rules for every /partner
// server action") plus its own cases: tenant AND kind isolation by crafted ids, the agent
// assignee rule, the internal-note visibility, audit in the same transaction, the unchanged
// outbox nudges, and the double-submit guard.
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

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { auditEvents, outbox, tickets, ticketMessages, partnerSites, partnerPortalSettings } from '@/db/schema';
import { resetCustomerPortalOriginCache } from '@/lib/customer-portal-url';
import { internalNoteAction, replyAction, setStatusAction } from '@/app/partner/(app)/support/[ticketId]/actions';
import { contactFollowUpAction, contactSmartRemitAction } from '@/app/partner/(app)/support/contact/actions';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const PHONE = '15557654321';
const NOT_FOUND = { ok: false, error: 'We could not find that ticket.' };
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
let keyN = 0;
const newKey = () => (++keyN).toString(16).padStart(32, '0');

async function signInAs(o: Partial<Staff>): Promise<Staff> {
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
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  return s;
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function seedTicket(id: string, partnerId: string, o: { kind?: 'customer' | 'internal'; assignedTo?: string; openedBy?: string } = {}) {
  const repo = createTicketRepo(db);
  await repo.createTicket({
    id,
    partnerId,
    kind: o.kind ?? 'customer',
    customerPhone: o.kind === 'internal' ? undefined : PHONE,
    openedBy: o.kind === 'internal' ? (o.openedBy ?? 'u1') : undefined,
    subject: `subject ${id}`,
    body: `first message ${id}`,
  });
  if (o.assignedTo) await repo.assign(id, o.assignedTo);
}

const audits = () => db.select().from(auditEvents);
const outboxRows = () => db.select().from(outbox);
const ticketRow = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0];
const messages = (id: string) => db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id));
const snapshot = async (id: string) => ({ t: await ticketRow(id), m: (await messages(id)).length });
const FINANCE_REDIRECT = (KNOWN_PARTNER_ROLES as readonly string[]).includes('finance') ? 'REDIRECT:/partner' : 'REDIRECT:/login';

function expectCleanAuditMeta(row: { meta: unknown }) {
  const meta = JSON.stringify(row.meta ?? {});
  expect(meta).not.toMatch(/\+?\d{10,}/);
  expect(meta).not.toContain('message');
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  await seedTicket('tk_a1', PA, { assignedTo: 'ag1' });
  await seedTicket('tk_a2', PA);
  await seedTicket('tk_b1', PB, { assignedTo: 'u1' });
  await seedTicket('tk_ai', PA, { kind: 'internal', openedBy: 'u1' });
  await seedTicket('tk_bi', PB, { kind: 'internal', openedBy: 'u1' });
  vi.clearAllMocks();
});

type Act = (fd: FormData) => Promise<unknown>;
const replyForm = (id: string, extra: Record<string, string> = {}) => form({ id, body: 'Thanks, we are on it.', requestKey: newKey(), ...extra });
const noteForm = (id: string, extra: Record<string, string> = {}) => form({ id, body: 'Checked the ledger.', requestKey: newKey(), ...extra });
const statusForm = (id: string, extra: Record<string, string> = {}) => form({ id, status: 'resolved', ...extra });
const followForm = (id: string, extra: Record<string, string> = {}) => form({ id, body: 'Any update on this?', requestKey: newKey(), ...extra });

// The checklist for the three customer-ticket actions (own = tk_a1 in PA; foreign = tk_b1 in PB).
describe.each([
  ['replyAction', replyAction as Act, replyForm, 'ticket.reply'],
  ['internalNoteAction', internalNoteAction as Act, noteForm, 'ticket.note'],
  ['setStatusAction', setStatusAction as Act, statusForm, 'ticket.status'],
] as const)('%s: per-action checklist', (_name, action, mk, auditAction) => {
  it('0. refuses on a partner-site host before anything else', async () => {
    await signInAs({ role: 'admin' });
    host.value = 'acme.smartremit.ai';
    await expect(action(mk('tk_a1'))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await audits()).toHaveLength(0);
  });
  it('1. anonymous → /login; platform staff → /admin-dashboard', async () => {
    await expect(action(mk('tk_a1'))).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined, role: 'admin' });
    await expect(action(mk('tk_a1'))).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await audits()).toHaveLength(0);
  });
  it('2. a disallowed role (finance) is bounced with no DB change', async () => {
    const before = await snapshot('tk_a1');
    await signInAs({ role: 'finance' as Staff['role'] });
    await expect(action(mk('tk_a1'))).rejects.toThrow(FINANCE_REDIRECT);
    expect(await snapshot('tk_a1')).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
  it("3. A acting on B's id → not found; B unchanged; no audit row", async () => {
    await signInAs({ role: 'admin' });
    const before = await snapshot('tk_b1');
    expect(await action(mk('tk_b1'))).toEqual(NOT_FOUND);
    expect(await snapshot('tk_b1')).toEqual(before);
    expect(await audits()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });
  it('3b. a crafted Contact SmartRemit (internal) id is not a customer ticket → not found', async () => {
    await signInAs({ role: 'admin' });
    const before = await snapshot('tk_ai');
    expect(await action(mk('tk_ai'))).toEqual(NOT_FOUND);
    expect(await snapshot('tk_ai')).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
  it('4. a smuggled partnerId=pb acts on A only; nothing references pb', async () => {
    await signInAs({ role: 'admin' });
    const before = await snapshot('tk_b1');
    expect(await action(mk('tk_a1', { partnerId: PB, partner: PB }))).toEqual({ ok: true });
    expect(await snapshot('tk_b1')).toEqual(before);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe(PA);
    expect(JSON.stringify(rows)).not.toContain(PB);
    expect(JSON.stringify(await outboxRows())).not.toContain(PB);
  });
  it('5. invalid input is refused before any write', async () => {
    await signInAs({ role: 'admin' });
    const before = await snapshot('tk_a1');
    const bad = auditAction === 'ticket.status' ? mk('tk_a1', { status: 'waiting_admin' }) : mk('tk_a1', { body: 'x'.repeat(4001) });
    const r = (await action(bad)) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(await snapshot('tk_a1')).toEqual(before);
    expect(await audits()).toHaveLength(0);
    // A malformed id is the same not-found.
    expect(await action(mk('../tk_a1'))).toEqual(NOT_FOUND);
  });
  it('6. success → exactly one audit row, tenant + actor + actorScope, no PII in meta', async () => {
    await signInAs({ username: 'sup1', role: 'support' });
    expect(await action(mk('tk_a1'))).toEqual({ ok: true });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'sup1', actorType: 'staff', action: auditAction, subjectId: 'tk_a1' });
    expect((rows[0].meta as Record<string, unknown>).actorScope).toBe('partner');
    expectCleanAuditMeta(rows[0]);
  });
  it('7. an agent may work only a ticket assigned to them (else the same not found)', async () => {
    await signInAs({ username: 'ag2', role: 'agent' });
    const before = await snapshot('tk_a1');
    expect(await action(mk('tk_a1'))).toEqual(NOT_FOUND);
    expect(await action(mk('tk_a2'))).toEqual(NOT_FOUND); // unassigned
    expect(await snapshot('tk_a1')).toEqual(before);
    expect(await audits()).toHaveLength(0);
    await signInAs({ username: 'ag1', role: 'agent' });
    expect(await action(mk('tk_a1'))).toEqual({ ok: true });
  });
});

describe('replyAction specifics', () => {
  it('appends a customer-visible reply and enqueues the SAME deduped nudge to the owning tenant, in one transaction with the audit', async () => {
    await signInAs({ username: 'sup1', role: 'support' });
    expect(await replyAction(replyForm('tk_a1'))).toEqual({ ok: true });
    const visible = await createTicketRepo(db).listMessages('tk_a1', { includeInternal: false });
    expect(visible.map((m) => m.body)).toContain('Thanks, we are on it.');
    const box = await outboxRows();
    expect(box).toHaveLength(1);
    const msg = visible.find((m) => m.body === 'Thanks, we are on it.')!;
    expect(box[0]).toMatchObject({ kind: 'whatsapp.text', dedupeKey: `ticketmsg:tk_a1:${msg.id}` });
    expect(box[0].payload).toMatchObject({ to: PHONE, partnerId: PA, category: 'nonessential' });
    expect((box[0].payload as { body: string }).body).not.toContain('SmartRemit'); // p4 C4: neutral wording
    const { pokeWorker } = await import('@/lib/outbox');
    expect(pokeWorker).toHaveBeenCalled();
  });
  it('the reply body is sealed at rest (the existing sealed writer)', async () => {
    await signInAs({ role: 'admin' });
    await replyAction(replyForm('tk_a1'));
    const raw = await messages('tk_a1');
    expect(raw.map((r) => r.body).join('|')).not.toContain('Thanks, we are on it.');
  });
  it('"waiting on customer" moves the ticket to pending', async () => {
    await signInAs({ role: 'admin' });
    await replyAction(replyForm('tk_a1', { waiting: 'on' }));
    expect((await ticketRow('tk_a1')).status).toBe('pending');
  });
  it('a double submit (same request key) writes once and reports success', async () => {
    await signInAs({ role: 'admin' });
    const fd = replyForm('tk_a1');
    expect(await replyAction(fd)).toEqual({ ok: true });
    expect(await replyAction(fd)).toEqual({ ok: true });
    expect((await messages('tk_a1')).length).toBe(2);
    expect(await audits()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  });
  it('the same request key with a different text or ticket is a NEW write, never a silent "sent"', async () => {
    await signInAs({ role: 'admin' });
    const key = newKey();
    expect(await replyAction(form({ id: 'tk_a1', body: 'first', requestKey: key }))).toEqual({ ok: true });
    expect(await replyAction(form({ id: 'tk_a1', body: 'second', requestKey: key }))).toEqual({ ok: true });
    expect(await replyAction(form({ id: 'tk_a2', body: 'first', requestKey: key }))).toEqual({ ok: true });
    const bodies = (await createTicketRepo(db).listMessages('tk_a1', { includeInternal: false })).map((m) => m.body);
    expect(bodies).toEqual(expect.arrayContaining(['first', 'second']));
    expect(await audits()).toHaveLength(3);
  });
  it('a missing request key is refused before any write', async () => {
    await signInAs({ role: 'admin' });
    const r = await replyAction(form({ id: 'tk_a1', body: 'hello' }));
    expect(r.ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
  it('a closed ticket refuses a reply', async () => {
    await createTicketRepo(db).updateStatus('tk_a1', 'closed');
    await signInAs({ role: 'admin' });
    const r = await replyAction(replyForm('tk_a1'));
    expect(r.ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
});

describe('internalNoteAction specifics', () => {
  it('the note is staff-only: excluded from the customer-visible list, and no nudge', async () => {
    await signInAs({ role: 'admin' });
    expect(await internalNoteAction(noteForm('tk_a1'))).toEqual({ ok: true });
    const repo = createTicketRepo(db);
    expect((await repo.listMessages('tk_a1', { includeInternal: false })).map((m) => m.body)).not.toContain('Checked the ledger.');
    const all = await repo.listMessages('tk_a1', { includeInternal: true });
    expect(all.find((m) => m.body === 'Checked the ledger.')?.internal).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('setStatusAction specifics', () => {
  it('resolve enqueues the same once-only resolve nudge (dedupe key ticketresolved:<id>)', async () => {
    await signInAs({ role: 'admin' });
    await setStatusAction(statusForm('tk_a1'));
    const box = await outboxRows();
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ kind: 'whatsapp.text', dedupeKey: 'ticketresolved:tk_a1' });
    expect((box[0].payload as { body: string }).body).not.toContain('SmartRemit'); // p4 C4
    expect((await ticketRow('tk_a1')).status).toBe('resolved');
  });
  it('a same-state move or a move out of closed is refused with no audit row', async () => {
    await signInAs({ role: 'admin' });
    const r = await setStatusAction(statusForm('tk_a1', { status: 'open' }));
    expect(r.ok).toBe(false);
    await setStatusAction(statusForm('tk_a1', { status: 'closed' }));
    expect(await audits()).toHaveLength(1);
    const r2 = await setStatusAction(statusForm('tk_a1', { status: 'open' }));
    expect(r2.ok).toBe(false);
    expect((await ticketRow('tk_a1')).status).toBe('closed');
    expect(await audits()).toHaveLength(1);
  });
  it('pending and closed are recorded in the audit meta (the status only)', async () => {
    await signInAs({ role: 'admin' });
    await setStatusAction(statusForm('tk_a1', { status: 'pending' }));
    expect((await audits())[0].meta).toEqual({ actorScope: 'partner', status: 'pending', from: 'open' });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('one customer portal: the nudge opens the ticket in the owning partner portal when it is live', () => {
  beforeEach(() => {
    resetCustomerPortalOriginCache();
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCustomerPortalOriginCache();
  });
  it('reply and resolve nudges link to the portal ticket; without a live portal, /account/support', async () => {
    await db.insert(partnerSites).values({ partnerId: PA, slug: 'alpha-pay' });
    await db.insert(partnerPortalSettings).values({ partnerId: PA, portalEnabledAt: new Date() });
    await signInAs({ role: 'admin' });
    await replyAction(replyForm('tk_a1'));
    await setStatusAction(statusForm('tk_a2'));
    const bodies = (await outboxRows()).map((r) => (r.payload as { body: string }).body);
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes('https://alpha-pay.smartremit.ai/portal/help/tickets/tk_a1'))).toBe(true);
    expect(bodies.some((b) => b.includes('https://alpha-pay.smartremit.ai/portal/help/tickets/tk_a2'))).toBe(true);
    for (const b of bodies) expect(b).not.toContain('/account/support');

    await signInAs({ partnerId: PB, role: 'admin' });
    await replyAction(replyForm('tk_b1'));
    const bravo = (await outboxRows()).map((r) => (r.payload as { body: string }).body).filter((b) => b.includes('tk_b1'));
    expect(bravo).toHaveLength(1);
    expect(bravo[0]).toContain('/account/support/tk_b1');
  });
});

describe('LOW-4: a partner cannot move a ticket out of waiting_admin (the escalation is SmartRemit\'s)', () => {
  it.each(['open', 'pending', 'resolved', 'closed'])('waiting_admin → %s is refused; nothing changes, no nudge, no audit', async (target) => {
    await createTicketRepo(db).updateStatus('tk_a1', 'waiting_admin');
    await signInAs({ role: 'admin' });
    const before = await snapshot('tk_a1');
    expect(await setStatusAction(statusForm('tk_a1', { status: target }))).toEqual({ ok: false, error: 'That status change is not allowed.' });
    expect(await snapshot('tk_a1')).toEqual(before);
    expect((await ticketRow('tk_a1')).status).toBe('waiting_admin');
    expect(await audits()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('a reply on an escalated (waiting_admin) ticket never de-escalates it', () => {
  it('"waiting on customer" is ignored: the reply is stored, the status stays waiting_admin', async () => {
    await createTicketRepo(db).updateStatus('tk_a1', 'waiting_admin');
    await signInAs({ role: 'admin' });
    expect(await replyAction(replyForm('tk_a1', { waiting: 'on' }))).toEqual({ ok: true });
    expect((await ticketRow('tk_a1')).status).toBe('waiting_admin');
    const msgs = await createTicketRepo(db).listMessages('tk_a1', { includeInternal: false });
    expect(msgs.map((m) => m.body)).toContain('Thanks, we are on it.');
    expect((await audits())[0].meta).toMatchObject({ actorScope: 'partner', waiting: false });
  });
});

describe("LOW-5: a partner pinned to the 'default' tenant has no Contact SmartRemit surface", () => {
  it('creating a thread is refused before any write', async () => {
    await signInAs({ username: 'dadm', role: 'admin', partnerId: DEFAULT_PARTNER_ID });
    const r = await contactSmartRemitAction(contactForm());
    expect(r).toEqual({ ok: false, error: 'Something went wrong. Nothing was changed. Try again.' });
    expect(await db.select().from(tickets)).toHaveLength(5);
    expect(await audits()).toHaveLength(0);
  });
  it('a follow-up on a default-tenant thread (even one you opened) is not found', async () => {
    await seedTicket('tk_dq', DEFAULT_PARTNER_ID, { kind: 'internal', openedBy: 'dsup' });
    await signInAs({ username: 'dsup', role: 'support', partnerId: DEFAULT_PARTNER_ID });
    const before = await snapshot('tk_dq');
    expect(await contactFollowUpAction(followForm('tk_dq'))).toEqual(NOT_FOUND);
    expect(await snapshot('tk_dq')).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
});

const contactForm = (extra: Record<string, string> = {}) =>
  form({ subject: 'Payout question', message: 'How do we change our settlement account?', requestKey: newKey(), ...extra });

describe('contactSmartRemitAction (Contact SmartRemit: a tenant → platform thread)', () => {
  it('0/1. site-host guard, then anonymous → /login, platform → /admin-dashboard', async () => {
    host.value = 'acme.smartremit.ai';
    await expect(contactSmartRemitAction(contactForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    host.value = 'smartremit.ai';
    await expect(contactSmartRemitAction(contactForm())).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(contactSmartRemitAction(contactForm())).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('2. finance is bounced; nothing is created', async () => {
    await signInAs({ role: 'finance' as Staff['role'] });
    await expect(contactSmartRemitAction(contactForm())).rejects.toThrow(FINANCE_REDIRECT);
    expect(await db.select().from(tickets)).toHaveLength(5);
  });
  it('4/6. creates an internal thread in the SESSION tenant (a smuggled partnerId is ignored), audited, then opens it', async () => {
    await signInAs({ username: 'sup1', role: 'support' });
    await expect(contactSmartRemitAction(contactForm({ partnerId: PB, partner: PB }))).rejects.toThrow(/^REDIRECT:\/partner\/support\/tk_/);
    const created = (await db.select().from(tickets)).filter((t) => !['tk_a1', 'tk_a2', 'tk_b1', 'tk_ai', 'tk_bi'].includes(t.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ partnerId: PA, kind: 'internal', openedBy: 'sup1', subject: 'Payout question', customerPhone: '' });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'sup1', action: 'ticket.contact.open', subjectId: created[0].id });
    expect((rows[0].meta as Record<string, unknown>).actorScope).toBe('partner');
    expect(JSON.stringify(rows)).not.toContain('Payout question');
    expect(JSON.stringify(rows)).not.toContain(PB);
    // No customer-ticket triage or WhatsApp nudge for an internal thread.
    expect(await outboxRows()).toHaveLength(0);
  });
  it('5. invalid subject or message is refused before any write', async () => {
    await signInAs({ role: 'admin' });
    for (const bad of <Record<string, string>[]>[{ subject: 'ab' }, { subject: 'x'.repeat(121) }, { message: 'short' }, { message: 'x'.repeat(2001) }, { requestKey: 'nope' }]) {
      const r = await contactSmartRemitAction(contactForm(bad));
      expect(r.ok, JSON.stringify(Object.keys(bad))).toBe(false);
    }
    expect(await db.select().from(tickets)).toHaveLength(5);
    expect(await audits()).toHaveLength(0);
  });
  it('a double submit creates one thread and lands on it both times', async () => {
    await signInAs({ role: 'admin' });
    const fd = contactForm();
    const first = await contactSmartRemitAction(fd).catch((e: Error) => e.message);
    const second = await contactSmartRemitAction(fd).catch((e: Error) => e.message);
    expect(first).toMatch(/^REDIRECT:\/partner\/support\/tk_/);
    expect(second).toBe(first);
    expect(await db.select().from(tickets)).toHaveLength(6);
    expect(await audits()).toHaveLength(1);
  });
  it('concurrent submits with fresh keys cannot overrun the cap', async () => {
    await signInAs({ username: 'racer', role: 'admin' });
    await Promise.all(Array.from({ length: 12 }, () => contactSmartRemitAction(contactForm()).catch(() => undefined)));
    expect((await db.select().from(tickets)).filter((t) => t.openedBy === 'racer').length).toBeLessThanOrEqual(5);
  });
  it('caps open threads per staff member', async () => {
    await signInAs({ username: 'capper', role: 'admin' });
    for (let i = 0; i < 5; i++) await contactSmartRemitAction(contactForm()).catch(() => undefined);
    const r = await contactSmartRemitAction(contactForm());
    expect(r.ok).toBe(false);
    expect((await db.select().from(tickets)).filter((t) => t.openedBy === 'capper')).toHaveLength(5);
  });
});

describe('A12: the contact form names who should answer', () => {
  const SEEDED = ['tk_a1', 'tk_a2', 'tk_b1', 'tk_ai', 'tk_bi'];
  const created = async () => (await db.select().from(tickets)).filter((x) => !SEEDED.includes(x.id));
  it('a form without the field (the previous build) keeps its meaning: addressed to SmartRemit', async () => {
    await signInAs({ username: 'ag9', role: 'agent' });
    await expect(contactSmartRemitAction(contactForm())).rejects.toThrow(/^REDIRECT:\/partner\/support\/tk_/);
    const rows = await created();
    expect(rows).toHaveLength(1);
    expect(rows[0].category ?? null).toBeNull();
    expect((await audits())[0].meta).toMatchObject({ actorScope: 'partner', audience: 'smartremit' });
  });
  it("'team' files a team question for the tenant's admins, audited with the audience", async () => {
    await signInAs({ username: 'ag9', role: 'agent' });
    await expect(contactSmartRemitAction(contactForm({ audience: 'team' }))).rejects.toThrow(/^REDIRECT:\/partner\/support\/tk_/);
    const rows = await created();
    expect(rows[0]).toMatchObject({ partnerId: PA, kind: 'internal', category: 'team_question', openedBy: 'ag9' });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'ticket.contact.open', subjectId: rows[0].id });
    expect(a[0].meta).toMatchObject({ actorScope: 'partner', audience: 'team' });
  });
  it('an unknown addressee is refused before any write', async () => {
    await signInAs({ role: 'admin' });
    for (const audience of ['', 'admins', 'platform']) {
      const r = await contactSmartRemitAction(contactForm({ audience }));
      expect(r).toEqual({ ok: false, error: 'Choose who should answer.' });
    }
    expect(await created()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });
});

describe('contactFollowUpAction (the opener follows up on their own thread)', () => {
  it('1/2. anonymous → /login; platform → /admin-dashboard; finance bounced', async () => {
    await expect(contactFollowUpAction(followForm('tk_ai'))).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(contactFollowUpAction(followForm('tk_ai'))).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs({ role: 'finance' as Staff['role'] });
    await expect(contactFollowUpAction(followForm('tk_ai'))).rejects.toThrow(FINANCE_REDIRECT);
    expect(await audits()).toHaveLength(0);
  });
  it("3. B's thread (even opened by a same-named user), a customer ticket, or a thread you did not open → not found", async () => {
    await signInAs({ username: 'u1', role: 'admin' });
    const before = await snapshot('tk_bi');
    expect(await contactFollowUpAction(followForm('tk_bi'))).toEqual(NOT_FOUND);
    expect(await snapshot('tk_bi')).toEqual(before);
    expect(await contactFollowUpAction(followForm('tk_a1'))).toEqual(NOT_FOUND);
    await signInAs({ username: 'someone', role: 'admin' });
    expect(await contactFollowUpAction(followForm('tk_ai'))).toEqual(NOT_FOUND);
    expect(await audits()).toHaveLength(0);
  });
  it('4/6. the opener posts a visible follow-up; one audit row in the session tenant', async () => {
    await signInAs({ username: 'u1', role: 'support' });
    expect(await contactFollowUpAction(followForm('tk_ai', { partnerId: PB }))).toEqual({ ok: true });
    const msgs = await createTicketRepo(db).listMessages('tk_ai', { includeInternal: false });
    expect(msgs.map((m) => m.body)).toContain('Any update on this?');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'u1', action: 'ticket.contact.reply', subjectId: 'tk_ai' });
    expect(JSON.stringify(rows)).not.toContain(PB);
  });
  it('5. an empty or over-long follow-up is refused; a closed thread refuses', async () => {
    await signInAs({ username: 'u1', role: 'support' });
    expect((await contactFollowUpAction(followForm('tk_ai', { body: ' ' }))).ok).toBe(false);
    expect((await contactFollowUpAction(followForm('tk_ai', { body: 'x'.repeat(4001) }))).ok).toBe(false);
    await createTicketRepo(db).updateStatus('tk_ai', 'closed');
    expect((await contactFollowUpAction(followForm('tk_ai'))).ok).toBe(false);
    expect(await audits()).toHaveLength(0);
  });
});
