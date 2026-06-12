import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// employee-questions actions — the internal-ticket flow (support staff ASK,
// admins ANSWER/resolve/close) over real PGlite. Covers: creation pinned to
// the asker's tenant, support staff seeing ONLY their own questions, the admin
// queue (platform-wide vs partner-pinned), audited answers/status changes, and
// the 404-never-403 collapse for out-of-scope and customer-kind tickets.

// Mutable staff identity — requireSupportOrAdmin returns {staff, scope}.
let currentStaff: Staff;
vi.mock('@/lib/auth', () => ({
  requireSupportOrAdmin: async () => ({
    staff: currentStaff,
    scope: currentStaff.partnerId
      ? { kind: 'partner', partnerId: currentStaff.partnerId }
      : { kind: 'platform' },
  }),
}));

let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  askQuestionAction,
  replyQuestionAction,
  answerQuestionAction,
  setQuestionStatusAction,
} from '@/app/admin-dashboard/employee-questions/actions';
import {
  listEmployeeQuestions,
  getEmployeeQuestion,
} from '@/app/admin-dashboard/employee-questions/queries';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';

function mkStaff(username: string, role: Staff['role'], partnerId?: string): Staff {
  return {
    username,
    name: username,
    role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt: new Date().toISOString(),
    ...(partnerId ? { partnerId } : {}),
  };
}

let n = 0;
const tid = () => `eq_${++n}`;

/** Seed an internal question directly (bypasses the action). */
async function seedQuestion(partnerId: string, openedBy: string, subject = 'q') {
  return createTicketRepo(db).createTicket({
    id: tid(),
    partnerId,
    kind: 'internal',
    openedBy,
    subject,
    body: `${subject} body`,
  });
}

function askForm(subject = 'How do I handle X?', question = 'Customer asked about X.') {
  const fd = new FormData();
  fd.set('subject', subject);
  fd.set('question', question);
  return fd;
}

function ticketForm(ticketId: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('ticketId', ticketId);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  currentStaff = mkStaff('sup1', 'support'); // platform-scoped support staff
  db = await freshDb();
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
});
afterEach(() => vi.clearAllMocks());

describe('askQuestionAction', () => {
  it('creates an internal ticket attributed to the asker (partnerId default for platform staff)', async () => {
    await askQuestionAction(askForm());
    const all = await createTicketRepo(db).listTickets({ kind: 'internal' });
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('internal');
    expect(all[0].openedBy).toBe('sup1');
    expect(all[0].partnerId).toBe('default');
    expect(all[0].status).toBe('open');
    const msgs = await createTicketRepo(db).listMessages(all[0].id, { includeInternal: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].actorType).toBe('staff');
    expect(msgs[0].actorId).toBe('sup1');
    expect(msgs[0].body).toBe('Customer asked about X.');
  });

  it("is PINNED to the asker's tenant — a form-smuggled partnerId is ignored", async () => {
    currentStaff = mkStaff('p1sup', 'support', 'p1');
    const fd = askForm();
    fd.set('partnerId', 'p2'); // hostile extra field
    await askQuestionAction(fd);
    const all = await createTicketRepo(db).listTickets({ kind: 'internal' });
    expect(all).toHaveLength(1);
    expect(all[0].partnerId).toBe('p1');
  });

  it('rejects a missing subject or question', async () => {
    await expect(askQuestionAction(askForm('', 'body'))).rejects.toThrow(/required/i);
    await expect(askQuestionAction(askForm('subject', '  '))).rejects.toThrow(/required/i);
    expect(await createTicketRepo(db).listTickets({ kind: 'internal' })).toHaveLength(0);
  });
});

describe('visibility (listEmployeeQuestions / getEmployeeQuestion)', () => {
  it('support staff see ONLY their own questions', async () => {
    const mine = await seedQuestion('default', 'sup1', 'mine');
    await seedQuestion('default', 'sup2', 'theirs');
    const seen = await listEmployeeQuestions(currentStaff);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(mine.id);

    // Thread reads follow the same rule — someone else's id is a plain miss.
    const others = await createTicketRepo(db).listTickets({ kind: 'internal' });
    const theirs = others.find((t) => t.openedBy === 'sup2')!;
    expect(await getEmployeeQuestion(currentStaff, theirs.id)).toBeNull();
    const own = await getEmployeeQuestion(currentStaff, mine.id);
    expect(own?.ticket.id).toBe(mine.id);
    expect(own?.messages).toHaveLength(1);
  });

  it('platform admins see the whole queue; partner admins are pinned to their partner', async () => {
    await seedQuestion('default', 'sup1');
    await seedQuestion('p1', 'p1sup');
    await seedQuestion('p2', 'p2sup');

    currentStaff = mkStaff('root', 'admin');
    expect(await listEmployeeQuestions(currentStaff)).toHaveLength(3);

    currentStaff = mkStaff('p1admin', 'admin', 'p1');
    const p1Seen = await listEmployeeQuestions(currentStaff);
    expect(p1Seen).toHaveLength(1);
    expect(p1Seen[0].partnerId).toBe('p1');
  });

  it('status filter narrows the admin queue', async () => {
    const a = await seedQuestion('default', 'sup1');
    await seedQuestion('default', 'sup2');
    await createTicketRepo(db).updateStatus(a.id, 'resolved');

    currentStaff = mkStaff('root', 'admin');
    const resolved = await listEmployeeQuestions(currentStaff, 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(a.id);
  });

  it('customer tickets NEVER surface here — not in the queue, not by id', async () => {
    const cust = await createTicketRepo(db).createTicket({
      id: tid(),
      partnerId: 'default',
      kind: 'customer',
      customerPhone: '15551230000',
      subject: 'where is my money',
      body: 'help',
    });
    currentStaff = mkStaff('root', 'admin');
    expect(await listEmployeeQuestions(currentStaff)).toHaveLength(0);
    expect(await getEmployeeQuestion(currentStaff, cust.id)).toBeNull();
  });
});

describe('answerQuestionAction (admin, audited)', () => {
  it('appends a staff answer and writes an audit_events row', async () => {
    const q = await seedQuestion('p1', 'p1sup');
    currentStaff = mkStaff('root', 'admin');
    await answerQuestionAction(ticketForm(q.id, { body: 'Here is how.' }));

    const msgs = await createTicketRepo(db).listMessages(q.id, { includeInternal: true });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].actorType).toBe('staff');
    expect(msgs[1].actorId).toBe('root');
    expect(msgs[1].body).toBe('Here is how.');

    const audit = await createAuditRepo(db).listRecent();
    const row = audit.find((r) => r.action === 'employee_question.answer');
    expect(row).toBeDefined();
    expect(row?.actor).toBe('root');
    expect(row?.subjectId).toBe(q.id);
    expect(row?.partnerId).toBe('p1');
  });

  it('support staff cannot answer', async () => {
    const q = await seedQuestion('default', 'sup2');
    currentStaff = mkStaff('sup1', 'support');
    await expect(answerQuestionAction(ticketForm(q.id, { body: 'nope' }))).rejects.toThrow(/admin role/i);
    expect(await createTicketRepo(db).listMessages(q.id, { includeInternal: true })).toHaveLength(1);
  });

  it("scope: a partner admin answering another tenant's question gets the generic miss", async () => {
    const q = await seedQuestion('p1', 'p1sup');
    currentStaff = mkStaff('p2admin', 'admin', 'p2');
    await expect(answerQuestionAction(ticketForm(q.id, { body: 'x' }))).rejects.toThrow(/not found/i);

    currentStaff = mkStaff('root', 'admin');
    await expect(answerQuestionAction(ticketForm('missing', { body: 'x' }))).rejects.toThrow(/not found/i);
  });

  it('a customer ticket id is a miss for answers too', async () => {
    const cust = await createTicketRepo(db).createTicket({
      id: tid(),
      partnerId: 'default',
      kind: 'customer',
      customerPhone: '15551230000',
      subject: 's',
      body: 'b',
    });
    currentStaff = mkStaff('root', 'admin');
    await expect(answerQuestionAction(ticketForm(cust.id, { body: 'x' }))).rejects.toThrow(/not found/i);
  });
});

describe('replyQuestionAction (opener follow-up)', () => {
  it('the opener can reply to their own thread', async () => {
    const q = await seedQuestion('default', 'sup1');
    await replyQuestionAction(ticketForm(q.id, { body: 'One more detail.' }));
    const msgs = await createTicketRepo(db).listMessages(q.id, { includeInternal: true });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].actorId).toBe('sup1');
  });

  it("someone else's thread is a generic miss; closed threads refuse", async () => {
    const q = await seedQuestion('default', 'sup2');
    await expect(replyQuestionAction(ticketForm(q.id, { body: 'x' }))).rejects.toThrow(/not found/i);

    const own = await seedQuestion('default', 'sup1');
    await createTicketRepo(db).updateStatus(own.id, 'closed');
    await expect(replyQuestionAction(ticketForm(own.id, { body: 'x' }))).rejects.toThrow(/closed/i);
  });
});

describe('setQuestionStatusAction (admin, audited)', () => {
  it('resolves then closes; closed is terminal', async () => {
    const q = await seedQuestion('default', 'sup1');
    currentStaff = mkStaff('root', 'admin');

    await setQuestionStatusAction(ticketForm(q.id, { status: 'resolved' }));
    expect((await createTicketRepo(db).getTicket(q.id))?.status).toBe('resolved');

    await setQuestionStatusAction(ticketForm(q.id, { status: 'closed' }));
    const closed = await createTicketRepo(db).getTicket(q.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.closedAt).toBeDefined();

    // Terminal: a second close (or any move) is refused by the repo guard.
    await expect(setQuestionStatusAction(ticketForm(q.id, { status: 'resolved' }))).rejects.toThrow(/not allowed/i);

    const audit = await createAuditRepo(db).listRecent();
    const rows = audit.filter((r) => r.action === 'employee_question.status');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.meta as { status: string }).status).sort()).toEqual(['closed', 'resolved']);
  });

  it('rejects other statuses, non-admin callers, and out-of-scope tickets', async () => {
    const q = await seedQuestion('p1', 'p1sup');

    currentStaff = mkStaff('root', 'admin');
    await expect(setQuestionStatusAction(ticketForm(q.id, { status: 'open' }))).rejects.toThrow(/resolved or closed/i);

    currentStaff = mkStaff('sup1', 'support');
    await expect(setQuestionStatusAction(ticketForm(q.id, { status: 'resolved' }))).rejects.toThrow(/admin role/i);

    currentStaff = mkStaff('p2admin', 'admin', 'p2');
    await expect(setQuestionStatusAction(ticketForm(q.id, { status: 'resolved' }))).rejects.toThrow(/not found/i);

    expect((await createTicketRepo(db).getTicket(q.id))?.status).toBe('open');
  });
});
