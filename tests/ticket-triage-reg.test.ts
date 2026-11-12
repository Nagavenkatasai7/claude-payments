import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { regCaseFor } from './helpers-pack8';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 8 T16 (P14, P33): AI triage only SUGGESTS on a regulatory case; the worker records
// what it suggested with `applied: false`; staff cannot apply a suggestion to a classed ticket;
// the status audit rows of a classed ticket carry the clock (critic R6).

let db: Db;
let currentStaff: Staff;

vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('@/lib/llm', () => ({ chat: chatMock }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  requireSupportOrAdmin: async () => ({ staff: currentStaff, scope: scopeOf(currentStaff) }),
  requireTicketWorker: async () => ({ staff: currentStaff, scope: scopeOf(currentStaff) }),
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createStore } from '@/lib/store';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { applyTriageAction, resolveAction, closeAction } from '@/app/admin-dashboard/tickets/actions';
import { listVisibleCustomerTickets } from '@/lib/partner-tickets';
import { REG_CASE_TRIAGE_REFUSAL } from '@/lib/reg-case-view';
import { auditEvents } from '@/db/schema';

const DAY = 86_400_000;
let staffList: Staff[] = [];

function staff(o: Partial<Staff> & { username: string }): Staff {
  return {
    name: o.username,
    role: 'support',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
}

function deps(): WorkerDeps {
  return {
    db,
    store: createStore(fakeRedis(), db),
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: vi.fn() as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => staffList,
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function runTriage(ticketId: string) {
  await createOutboxRepo(db).enqueue('ticket.triage', { ticketId }, { dedupeKey: `triage:${ticketId}` });
  const r = await drainOnce(deps(), 'w1');
  expect(r.processed).toBeGreaterThanOrEqual(1);
}

const auditsOf = async (subjectId: string, action: string) =>
  (await db.select().from(auditEvents).where(eq(auditEvents.subjectId, subjectId))).filter((a) => a.action === action);

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
  chatMock.mockReset();
  // The model suggests delay / low (an in-list classification triageSuggest keeps as is).
  chatMock.mockResolvedValue({ role: 'assistant', content: '{"category":"delay","priority":"low"}' });
  staffList = [];
  currentStaff = staff({ username: 'sup1' });
});

describe('worker ticket.triage on a regulatory case (T16)', () => {
  it('the worker keeps a classed ticket and records the suggestion', async () => {
    staffList = [staff({ username: 'venkat', role: 'agent' })];
    const t = await regCaseFor(db, 'p1', { regClass: 'error_notice' });
    expect(t.priority).toBe('urgent');
    await runTriage(t.id);
    const after = await createTicketRepo(db).getTicket(t.id);
    expect(after!.priority).toBe('urgent');
    expect(after!.category).toBe('refund');
    const rows = await auditsOf(t.id, 'ticket.triage');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ source: 'copilot', category: 'delay', priority: 'low', applied: false });
    // the load-balancer still assigns
    expect(after!.assignedTo).toBe('venkat');
  });

  it('an unclassed ticket is applied as today', async () => {
    const t = await createTicketRepo(db).createTicket({
      id: 'tk_plain1', partnerId: 'p1', kind: 'customer', customerPhone: '15555550123',
      subject: 'Where is my money', body: 'It is late.',
    });
    await runTriage(t.id);
    const after = await createTicketRepo(db).getTicket(t.id);
    expect(after!.category).toBe('delay');
    expect(after!.priority).toBe('low');
    const rows = await auditsOf(t.id, 'ticket.triage');
    expect(rows[0].meta).toEqual({ source: 'copilot', category: 'delay', priority: 'low', applied: true });
  });

  it('the suggestion read is tenant-scoped', async () => {
    const t = await regCaseFor(db, 'p1', { regClass: 'complaint' });
    await runTriage(t.id);
    // A row of another partner with the same subject id is never read.
    await createAuditRepo(db).record({
      partnerId: 'p2', actor: 'system', actorType: 'system', action: 'ticket.triage', subjectId: t.id,
      meta: { source: 'copilot', category: 'kyc', priority: 'normal', applied: false },
    });
    const row = await createAuditRepo(db).latestForSubject(t.partnerId, t.id, 'ticket.triage');
    expect(row!.meta).toEqual({ source: 'copilot', category: 'delay', priority: 'low', applied: false });
    expect(await createAuditRepo(db).latestForSubject('p3', t.id, 'ticket.triage')).toBeNull();
  });
});

describe('applyTriageAction on a regulatory case (T16)', () => {
  it('refuses a classed ticket and writes nothing; an unclassed ticket still works', async () => {
    const t = await regCaseFor(db, 'p1', { regClass: 'fraud_report' });
    await expect(
      applyTriageAction(form({ ticketId: t.id, category: 'delay', priority: 'low' })),
    ).rejects.toThrow(REG_CASE_TRIAGE_REFUSAL);
    expect(await auditsOf(t.id, 'ticket.triage')).toEqual([]);
    const after = await createTicketRepo(db).getTicket(t.id);
    expect(after!.priority).toBe('urgent');
    expect(after!.category).toBe('refund');

    const u = await createTicketRepo(db).createTicket({
      id: 'tk_plain2', partnerId: 'p1', kind: 'customer', customerPhone: '15555550123', subject: 's', body: 'b',
    });
    await applyTriageAction(form({ ticketId: u.id, category: 'delay', priority: 'urgent' }));
    const uAfter = await createTicketRepo(db).getTicket(u.id);
    expect(uAfter!.category).toBe('delay');
    expect(uAfter!.priority).toBe('urgent');
    expect((await auditsOf(u.id, 'ticket.triage'))[0].meta).toEqual({ category: 'delay', priority: 'urgent', source: 'copilot' });
  });
});

describe('partner rows carry the class (T16)', () => {
  it('listVisibleCustomerTickets exposes regClass and dueAt; never another tenant', async () => {
    const mine = await regCaseFor(db, 'p1', { regClass: 'error_notice' });
    const theirs = await regCaseFor(db, 'p2', { regClass: 'complaint' });
    const rows = await listVisibleCustomerTickets({ role: 'admin', username: 'a1', partnerId: 'p1' }, {}, db);
    const row = rows.find((r) => r.id === mine.id);
    expect(row!.regClass).toBe('error_notice');
    expect(row!.dueAt).toBe(mine.dueAt);
    expect(rows.some((r) => r.id === theirs.id)).toBe(false);
  });
});

describe('a classed status change records the clock (critic R6)', () => {
  it('resolveAction before the due date: beforeDue true', async () => {
    const t = await regCaseFor(db, 'p1', { regClass: 'error_notice', dueInMs: DAY });
    await resolveAction(form({ ticketId: t.id }));
    const rows = await auditsOf(t.id, 'ticket.resolve');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ regClass: 'error_notice', dueAt: t.dueAt, beforeDue: true });
  });

  it('closeAction after the due date: beforeDue false', async () => {
    const t = await regCaseFor(db, 'p1', { regClass: 'complaint', dueInMs: -DAY });
    await closeAction(form({ ticketId: t.id }));
    const rows = await auditsOf(t.id, 'ticket.close');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ regClass: 'complaint', dueAt: t.dueAt, beforeDue: false });
  });

  it('an unclassed status change is byte-identical (no meta)', async () => {
    const repo = createTicketRepo(db);
    const a = await repo.createTicket({ id: 'tk_u1', partnerId: 'p1', kind: 'customer', customerPhone: '15555550123', subject: 's', body: 'b' });
    const b = await repo.createTicket({ id: 'tk_u2', partnerId: 'p1', kind: 'customer', customerPhone: '15555550123', subject: 's', body: 'b' });
    await resolveAction(form({ ticketId: a.id }));
    await closeAction(form({ ticketId: b.id }));
    expect((await auditsOf(a.id, 'ticket.resolve'))[0].meta).toBeNull();
    expect((await auditsOf(b.id, 'ticket.close'))[0].meta).toBeNull();
  });
});
