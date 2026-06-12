'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSupportOrAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { newTransferId } from '@/lib/id';
import { getEmployeeQuestion } from './queries';

/**
 * Employee questions — the internal-ticket flow: support staff ASK the admins;
 * admins ANSWER, resolve, and close. Every action is a public POST endpoint,
 * so each self-gates (requireSupportOrAdmin + an explicit admin re-check on
 * the answer/status mutations), re-loads the target through the shared scoped
 * reader (kind 'internal' only — a customer ticket id is a miss here), and
 * collapses missing/out-of-scope ids to the same generic error. Admin answers
 * and status changes land in the append-only audit_events ledger, like every
 * other admin action.
 */

const BASE = '/admin-dashboard/employee-questions';

// Generic miss — out-of-scope ids look exactly like missing ones.
const NOT_FOUND = 'Question not found.';

function refresh(ticketId: string): void {
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${ticketId}`);
}

/** A support staffer (or admin) asks the admins a question. */
export async function askQuestionAction(formData: FormData): Promise<void> {
  const { staff } = await requireSupportOrAdmin();
  const subject = String(formData.get('subject') ?? '').trim();
  const question = String(formData.get('question') ?? '').trim();
  if (!subject || !question) throw new Error('Subject and question are both required.');

  const id = newTransferId();
  await createTicketRepo(getDb()).createTicket({
    id,
    // PINNED to the asker's own tenant — never read from the form.
    partnerId: staff.partnerId ?? 'default',
    kind: 'internal',
    openedBy: staff.username,
    subject,
    body: question,
  });
  refresh(id);
  redirect(`${BASE}/${id}`);
}

/** The OPENER follows up on their own question (no audit — not an admin act). */
export async function replyQuestionAction(formData: FormData): Promise<void> {
  const { staff } = await requireSupportOrAdmin();
  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (!body) throw new Error('Reply text is required.');

  const found = await getEmployeeQuestion(staff, ticketId);
  // Reply is opener-only regardless of role — admins answer via the audited
  // action below (an admin replying to their own question still passes here).
  if (!found || found.ticket.openedBy !== staff.username) throw new Error(NOT_FOUND);
  if (found.ticket.status === 'closed') throw new Error('This question is closed.');

  await createTicketRepo(getDb()).appendMessage({
    ticketId: found.ticket.id,
    actorType: 'staff',
    actorId: staff.username,
    body,
  });
  refresh(found.ticket.id);
}

/** An admin answers a question in their scope (audited). */
export async function answerQuestionAction(formData: FormData): Promise<void> {
  const { staff } = await requireSupportOrAdmin();
  if (staff.role !== 'admin') throw new Error('Admin role required.');
  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (!body) throw new Error('Answer text is required.');

  const found = await getEmployeeQuestion(staff, ticketId);
  if (!found) throw new Error(NOT_FOUND);
  if (found.ticket.status === 'closed') throw new Error('This question is closed.');

  const db = getDb();
  await createTicketRepo(db).appendMessage({
    ticketId: found.ticket.id,
    actorType: 'staff',
    actorId: staff.username,
    body,
  });
  await createAuditRepo(db).record({
    partnerId: found.ticket.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'employee_question.answer',
    subjectId: found.ticket.id,
  });
  refresh(found.ticket.id);
}

/** An admin resolves or closes a question (audited; closed is terminal). */
export async function setQuestionStatusAction(formData: FormData): Promise<void> {
  const { staff } = await requireSupportOrAdmin();
  if (staff.role !== 'admin') throw new Error('Admin role required.');
  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const status = String(formData.get('status') ?? '');
  if (status !== 'resolved' && status !== 'closed') {
    throw new Error('Status must be resolved or closed.');
  }

  const found = await getEmployeeQuestion(staff, ticketId);
  if (!found) throw new Error(NOT_FOUND);

  // Repo guard: closed is terminal; same-state moves refuse. Null ⇒ refused.
  const db = getDb();
  const updated = await createTicketRepo(db).updateStatus(found.ticket.id, status);
  if (!updated) throw new Error('That status change is not allowed.');

  await createAuditRepo(db).record({
    partnerId: found.ticket.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'employee_question.status',
    subjectId: found.ticket.id,
    meta: { status },
  });
  refresh(found.ticket.id);
}
