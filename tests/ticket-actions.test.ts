import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { Staff, TicketStatus } from '@/lib/types';

/**
 * B3 — ticket server actions (PGlite). The actions are public POST endpoints:
 * each must self-gate via requireSupportOrAdmin AND re-resolve the ticket under
 * the caller's scope BEFORE mutating. Partner staff pinned to their tenant can
 * never touch another partner's ticket even with a direct id; replies enqueue
 * exactly one deduped WhatsApp nudge; closed is terminal everywhere.
 */

let currentStaff: Staff;
let db: Db;

vi.mock('@/lib/auth', () => ({
  requireSupportOrAdmin: async () => ({ staff: currentStaff, scope: scopeOf(currentStaff) }),
  requireStaff: async () => currentStaff,
  requireAdmin: async () => currentStaff,
  requireScope: vi.fn(),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
const sharedRedis = fakeRedis();
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(sharedRedis) };
});
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  replyAction,
  internalNoteAction,
  assignTicketAction,
  escalateAction,
  resolveAction,
  closeAction,
  applyTriageAction,
  copilotRejectAction,
} from '@/app/admin-dashboard/tickets/actions';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuthStore } from '@/lib/auth-store';
import { outbox, auditEvents } from '@/db/schema';

const authStore = createAuthStore(sharedRedis);

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'sup1',
    name: 'Support One',
    role: 'support',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

let n = 0;
async function makeTicket(
  partnerId: string,
  overrides: { customerPhone?: string; kind?: 'customer' | 'internal'; status?: TicketStatus } = {},
) {
  const repo = createTicketRepo(db);
  const t = await repo.createTicket({
    id: `tk_${++n}`,
    partnerId,
    kind: overrides.kind ?? 'customer',
    ...(overrides.kind === 'internal'
      ? { openedBy: 'someone' }
      : { customerPhone: overrides.customerPhone ?? '15551230000' }),
    subject: 'Where is my transfer?',
    body: 'It has been two days.',
  });
  if (overrides.status && overrides.status !== 'open') {
    await repo.updateStatus(t.id, overrides.status);
  }
  return t;
}

async function outboxRows() {
  return db.select().from(outbox);
}
async function auditRows() {
  return db.select().from(auditEvents);
}

beforeEach(async () => {
  sharedRedis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
  currentStaff = staff({});
});

describe('scope pinning (404-never-403)', () => {
  it('partner staff cannot reply to another partner’s ticket even with a direct id', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p2' });
    await expect(
      replyAction(form({ ticketId: t.id, body: 'hi' })),
    ).rejects.toThrow(/not found/i);
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(1); // untouched
    expect(await outboxRows()).toHaveLength(0);
  });

  it('partner staff cannot escalate/resolve/close/assign/triage across tenants', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p2' });
    await expect(escalateAction(form({ ticketId: t.id, reason: 'r' }))).rejects.toThrow(/not found/i);
    await expect(resolveAction(form({ ticketId: t.id }))).rejects.toThrow(/not found/i);
    await expect(closeAction(form({ ticketId: t.id }))).rejects.toThrow(/not found/i);
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: '' }))).rejects.toThrow(/not found/i);
    await expect(
      applyTriageAction(form({ ticketId: t.id, category: 'delay', priority: 'normal' })),
    ).rejects.toThrow(/not found/i);
    await expect(copilotRejectAction(t.id)).rejects.toThrow(/not found/i);
    expect((await createTicketRepo(db).getTicket(t.id))?.status).toBe('open');
  });

  it('internal-kind tickets are unreachable from these actions (they live on employee-questions)', async () => {
    const t = await makeTicket('default', { kind: 'internal' });
    currentStaff = staff({}); // platform support
    await expect(replyAction(form({ ticketId: t.id, body: 'hi' }))).rejects.toThrow(/not found/i);
  });

  it('platform support staff CAN act on any partner’s customer ticket', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({});
    await replyAction(form({ ticketId: t.id, body: 'On it.' }));
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(2);
  });
});

describe('replyAction', () => {
  it('appends a public staff message and enqueues exactly ONE deduped nudge', async () => {
    const t = await makeTicket('p1', { customerPhone: '15559998888' });
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'We are checking.' }));

    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].actorType).toBe('staff');
    expect(msgs[1].actorId).toBe('sup1');
    expect(msgs[1].internal).toBe(false);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('whatsapp.text');
    expect(rows[0].dedupeKey).toBe(`ticketmsg:${t.id}:${msgs[1].id}`);
    const payload = rows[0].payload as { to: string; body: string };
    expect(payload.to).toBe('15559998888');
    expect(payload.body).toContain(`/account/support/${t.id}`);
  });

  it('each reply gets its own nudge (per-message dedupe keys differ)', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'first' }));
    await replyAction(form({ ticketId: t.id, body: 'second' }));
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
  });

  it('status flips to pending ONLY when the waiting box is checked', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'no box' }));
    expect((await createTicketRepo(db).getTicket(t.id))?.status).toBe('open');
    await replyAction(form({ ticketId: t.id, body: 'with box', waiting: 'on' }));
    expect((await createTicketRepo(db).getTicket(t.id))?.status).toBe('pending');
  });

  it('skips the nudge silently when the customer phone is empty', async () => {
    const t = await makeTicket('p1', { customerPhone: '' });
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'reply anyway' }));
    expect(await outboxRows()).toHaveLength(0);
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(2); // the reply itself still lands
  });

  it('records copilot provenance audits (accept / edit)', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'verbatim', copilot: 'accepted' }));
    await replyAction(form({ ticketId: t.id, body: 'tweaked', copilot: 'edited' }));
    const actions = (await auditRows()).map((r) => r.action);
    expect(actions).toContain('copilot.accept');
    expect(actions).toContain('copilot.edit');
    expect(actions.filter((a) => a === 'ticket.reply')).toHaveLength(2);
  });
});

describe('internalNoteAction', () => {
  it('appends an internal note and never nudges the customer', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await internalNoteAction(form({ ticketId: t.id, body: 'internal context' }));
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs[1].internal).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
    // …and the customer view never sees it
    const visible = await createTicketRepo(db).listMessages(t.id, { includeInternal: false });
    expect(visible).toHaveLength(1);
  });
});

describe('escalate / resolve transitions', () => {
  it('escalate flips to waiting_admin and appends the internal system message', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await escalateAction(form({ ticketId: t.id, reason: 'needs an admin call' }));
    expect((await createTicketRepo(db).getTicket(t.id))?.status).toBe('waiting_admin');
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    const sys = msgs.find((m) => m.actorType === 'system');
    expect(sys?.body).toBe('Escalated to admins: needs an admin call');
    expect(sys?.internal).toBe(true);
  });

  it('resolve flips to resolved and sends the final nudge exactly ONCE ever', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await resolveAction(form({ ticketId: t.id }));
    expect((await createTicketRepo(db).getTicket(t.id))?.status).toBe('resolved');
    let nudges = (await outboxRows()).filter((r) => r.dedupeKey === `ticketresolved:${t.id}`);
    expect(nudges).toHaveLength(1);
    // reopen → re-resolve: the dedupe key is spent, no second nudge
    await createTicketRepo(db).updateStatus(t.id, 'open');
    await resolveAction(form({ ticketId: t.id }));
    nudges = (await outboxRows()).filter((r) => r.dedupeKey === `ticketresolved:${t.id}`);
    expect(nudges).toHaveLength(1);
  });

  it('escalating an already-escalated ticket refuses (same-state guard)', async () => {
    const t = await makeTicket('p1', { status: 'waiting_admin' });
    currentStaff = staff({ partnerId: 'p1' });
    await expect(escalateAction(form({ ticketId: t.id, reason: 'again' }))).rejects.toThrow(
      /cannot be escalated/i,
    );
  });
});

describe('closed is terminal', () => {
  it('every mutation refuses on a closed ticket', async () => {
    const t = await makeTicket('p1', { status: 'closed' });
    currentStaff = staff({ partnerId: 'p1' });
    await expect(replyAction(form({ ticketId: t.id, body: 'x' }))).rejects.toThrow(/closed/i);
    await expect(internalNoteAction(form({ ticketId: t.id, body: 'x' }))).rejects.toThrow(/closed/i);
    await expect(escalateAction(form({ ticketId: t.id, reason: 'x' }))).rejects.toThrow(/cannot/i);
    await expect(resolveAction(form({ ticketId: t.id }))).rejects.toThrow(/cannot/i);
    await expect(closeAction(form({ ticketId: t.id }))).rejects.toThrow(/cannot/i);
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: '' }))).rejects.toThrow(/closed/i);
    await expect(
      applyTriageAction(form({ ticketId: t.id, category: 'delay', priority: 'low' })),
    ).rejects.toThrow(/closed/i);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('assignTicketAction', () => {
  it('assigns to an active, scope-compatible support teammate', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await authStore.saveStaff(staff({ username: 'sup2', partnerId: 'p1' }));
    await assignTicketAction(form({ ticketId: t.id, assignee: 'sup2' }));
    expect((await createTicketRepo(db).getTicket(t.id))?.assignedTo).toBe('sup2');
  });

  it('rejects unknown, suspended, money-role, and cross-partner assignees', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: 'ghost' }))).rejects.toThrow(
      /unknown/i,
    );
    await authStore.saveStaff(staff({ username: 'frozen', partnerId: 'p1', status: 'suspended' }));
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: 'frozen' }))).rejects.toThrow(
      /inactive/i,
    );
    await authStore.saveStaff(staff({ username: 'agentx', role: 'agent', partnerId: 'p1' }));
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: 'agentx' }))).rejects.toThrow(
      /support staff and admins/i,
    );
    await authStore.saveStaff(staff({ username: 'other', partnerId: 'p2' }));
    await expect(assignTicketAction(form({ ticketId: t.id, assignee: 'other' }))).rejects.toThrow(
      /scope/i,
    );
    expect((await createTicketRepo(db).getTicket(t.id))?.assignedTo).toBeUndefined();
  });

  it('empty assignee unassigns', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await authStore.saveStaff(staff({ username: 'sup2', partnerId: 'p1' }));
    await assignTicketAction(form({ ticketId: t.id, assignee: 'sup2' }));
    await assignTicketAction(form({ ticketId: t.id, assignee: '' }));
    expect((await createTicketRepo(db).getTicket(t.id))?.assignedTo).toBeUndefined();
  });
});

describe('applyTriageAction', () => {
  it('clamps to the closed lists — off-list values are refused outright', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await expect(
      applyTriageAction(form({ ticketId: t.id, category: 'hacking', priority: 'normal' })),
    ).rejects.toThrow(/invalid/i);
    await expect(
      applyTriageAction(form({ ticketId: t.id, category: 'delay', priority: 'mega' })),
    ).rejects.toThrow(/invalid/i);
    await applyTriageAction(form({ ticketId: t.id, category: 'delay', priority: 'urgent' }));
    const after = await createTicketRepo(db).getTicket(t.id);
    expect(after?.category).toBe('delay');
    expect(after?.priority).toBe('urgent');
  });
});

describe('audit trail', () => {
  it('every action writes an append-only audit_events row', async () => {
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await authStore.saveStaff(staff({ username: 'sup2', partnerId: 'p1' }));
    await replyAction(form({ ticketId: t.id, body: 'r' }));
    await internalNoteAction(form({ ticketId: t.id, body: 'n' }));
    await assignTicketAction(form({ ticketId: t.id, assignee: 'sup2' }));
    await escalateAction(form({ ticketId: t.id, reason: 'why' }));
    await applyTriageAction(form({ ticketId: t.id, category: 'refund', priority: 'low' }));
    await copilotRejectAction(t.id);
    await resolveAction(form({ ticketId: t.id }));
    await closeAction(form({ ticketId: t.id }));
    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    for (const a of [
      'ticket.reply', 'ticket.note', 'ticket.assign', 'ticket.escalate',
      'ticket.triage', 'copilot.reject', 'ticket.resolve', 'ticket.close',
    ]) {
      expect(actions).toContain(a);
    }
    // every row names the actor and the ticket
    for (const r of rows) {
      expect(r.actor).toBe('sup1');
      expect(r.subjectId).toBe(t.id);
      expect(r.partnerId).toBe('p1');
    }
  });
});
