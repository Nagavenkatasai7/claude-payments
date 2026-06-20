'use server';

import { revalidatePath } from 'next/cache';
import { requireSupportOrAdmin, requireTicketWorker } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { scopeOf, canSee, type Scope } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { pokeWorker } from '@/lib/outbox';
import { env } from '@/lib/env';
import { TICKET_CATEGORIES, type TicketCategory } from '@/lib/ticket-ai';
import type { Staff, Ticket, TicketPriority } from '@/lib/types';

// Ticket actions (B3 — the employee/support dashboard). Every action is a
// public POST endpoint, so each one self-gates with requireSupportOrAdmin
// (NEVER requireScope — that helper bounces support staff away from tickets)
// and re-resolves the ticket UNDER THE CALLER'S SCOPE before mutating: a
// partner-scoped staff member curling another tenant's ticket id gets the
// same generic "not found" as a missing one (404-never-403). Only 'customer'
// tickets are reachable here — internal (employee-question) tickets live on
// the admin employee-questions surface.

const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'urgent'];

async function getScopedTicket(scope: Scope, id: string): Promise<Ticket> {
  if (!id) throw new Error('Ticket not found');
  const repo = createTicketRepo(getDb());
  const ticket =
    scope.kind === 'partner'
      ? await repo.getOwnedTicket(scope.partnerId, id)
      : await repo.getTicket(id);
  if (!ticket || ticket.kind !== 'customer') throw new Error('Ticket not found');
  return ticket;
}

function requireOpen(ticket: Ticket): void {
  if (ticket.status === 'closed') throw new Error('Ticket is closed.');
}

/**
 * Assignee-scoping for AGENTS: an agent may only work a ticket assigned to them.
 * Support/admins are unrestricted (their queue is the whole tenant). Same opaque
 * "not found" as the cross-tenant guard — 404-never-403, no oracle over which
 * ticket ids exist or who they belong to.
 */
function assertCanWork(staff: Staff, ticket: Ticket): void {
  if (staff.role === 'agent' && ticket.assignedTo !== staff.username) {
    throw new Error('Ticket not found');
  }
}

async function audit(
  staff: Staff,
  ticket: Ticket,
  action: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await createAuditRepo(getDb()).record({
    partnerId: ticket.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action,
    subjectId: ticket.id,
    meta,
  });
}

/** The customer-facing nudge link — /account/support is the customer portal view. */
function supportUrl(ticketId: string): string {
  return `${env.appBaseUrl}/account/support/${ticketId}`;
}

/**
 * Public staff reply. Appends the message, optionally flips to 'pending'
 * (waiting on customer — ONLY when the replier checked the box), and enqueues
 * ONE deduped WhatsApp nudge on the OWNING partner's number — skipped silently
 * when the ticket has no customer phone. The append + status flip + nudge
 * commit in one transaction (the outbox-with-state-change invariant).
 */
export async function replyAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim().slice(0, 4000);
  const waiting = formData.get('waiting') === 'on';
  const copilot = String(formData.get('copilot') ?? '');
  if (!body) throw new Error('Reply cannot be empty.');
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  requireOpen(ticket);

  const db = getDb();
  // The nudge rides the OWNING partner's WhatsApp number (brand-side), exactly
  // like reconcile's customer-facing sends. Resolved OUTSIDE the transaction —
  // it's a read; the payload carries the creds like every whatsapp.text row.
  const waCreds = waCredsFrom(await createIntegrationsRepo(db).getIntegrations(ticket.partnerId));
  await db.transaction(async (tx) => {
    const repo = createTicketRepo(tx);
    const msg = await repo.appendMessage({
      ticketId: ticket.id,
      actorType: 'staff',
      actorId: staff.username,
      body,
      internal: false,
    });
    if (waiting) await repo.updateStatus(ticket.id, 'pending');
    if (ticket.customerPhone) {
      await createOutboxRepo(tx).enqueue(
        'whatsapp.text',
        {
          to: ticket.customerPhone,
          body: `You have a new reply from support — view it in your SmartRemit dashboard: ${supportUrl(ticket.id)}`,
          creds: waCreds,
        },
        { dedupeKey: `ticketmsg:${ticket.id}:${msg.id}` },
      );
    }
  });
  pokeWorker();
  await audit(staff, ticket, 'ticket.reply', { waiting });
  // Copilot provenance (set by the panel at submit time): the staff member
  // sent the AI draft verbatim ('accepted') or after editing it ('edited').
  if (copilot === 'accepted' || copilot === 'edited') {
    await audit(staff, ticket, copilot === 'accepted' ? 'copilot.accept' : 'copilot.edit');
  }
  revalidatePath('/admin-dashboard', 'layout');
}

/** Staff-only internal note — never visible to the customer, never nudges. */
export async function internalNoteAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim().slice(0, 4000);
  if (!body) throw new Error('Note cannot be empty.');
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  requireOpen(ticket);
  await createTicketRepo(getDb()).appendMessage({
    ticketId: ticket.id,
    actorType: 'staff',
    actorId: staff.username,
    body,
    internal: true,
  });
  await audit(staff, ticket, 'ticket.note');
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * (Re)assign (or unassign with an empty value) — support/admins only (agents
 * can't reassign; the load balancer + this dropdown own who works what). The
 * assignee must be a real, active, in-scope, non-test staff member of any
 * ticket-capable role (support, admin, OR agent) — agents are now first-class
 * ticket handlers. Same no-cross-partner-assignment rule as transfers (M2).
 */
export async function assignTicketAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireSupportOrAdmin();
  const ticketId = String(formData.get('ticketId') ?? '');
  const assignee = String(formData.get('assignee') ?? '');
  const ticket = await getScopedTicket(scope, ticketId);
  if (assignee) {
    const assigneeStaff = await getAuthStore().getStaff(assignee);
    if (!assigneeStaff) throw new Error('Cannot assign: unknown staff member.');
    if (assigneeStaff.status === 'suspended') {
      throw new Error('Cannot assign: staff member is inactive.');
    }
    if (!canSee(scopeOf(assigneeStaff), ticket.partnerId)) {
      throw new Error('Cannot assign: staff member is outside this ticket’s scope.');
    }
  }
  const updated = await createTicketRepo(getDb()).assign(ticket.id, assignee || null);
  if (!updated) throw new Error('Ticket is closed.');
  await audit(staff, ticket, 'ticket.assign', { assignee: assignee || null });
  revalidatePath('/admin-dashboard', 'layout');
}

/** Escalate to the admins: waiting_admin + an internal system note with the reason. */
export async function escalateAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 500);
  if (!reason) throw new Error('A reason is required to escalate.');
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  await getDb().transaction(async (tx) => {
    const repo = createTicketRepo(tx);
    const updated = await repo.updateStatus(ticket.id, 'waiting_admin');
    if (!updated) throw new Error('Ticket cannot be escalated.');
    await repo.appendMessage({
      ticketId: ticket.id,
      actorType: 'system',
      actorId: 'system',
      body: `Escalated to admins: ${reason}`,
      internal: true,
    });
  });
  await audit(staff, ticket, 'ticket.escalate', { reason });
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Resolve — and tell the customer ONCE: the final nudge is deduped on the
 * ticket id alone, so a reopen→re-resolve cycle never re-sends it.
 */
export async function resolveAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  const db = getDb();
  const waCreds = waCredsFrom(await createIntegrationsRepo(db).getIntegrations(ticket.partnerId));
  await db.transaction(async (tx) => {
    const updated = await createTicketRepo(tx).updateStatus(ticket.id, 'resolved');
    if (!updated) throw new Error('Ticket cannot be resolved.');
    if (ticket.customerPhone) {
      await createOutboxRepo(tx).enqueue(
        'whatsapp.text',
        {
          to: ticket.customerPhone,
          body: `Your support request has been resolved — view it in your SmartRemit dashboard: ${supportUrl(ticket.id)}`,
          creds: waCreds,
        },
        { dedupeKey: `ticketresolved:${ticket.id}` },
      );
    }
  });
  pokeWorker();
  await audit(staff, ticket, 'ticket.resolve');
  revalidatePath('/admin-dashboard', 'layout');
}

/** Close — terminal (the repo guard refuses every later transition). No nudge. */
export async function closeAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  const updated = await createTicketRepo(getDb()).updateStatus(ticket.id, 'closed');
  if (!updated) throw new Error('Ticket cannot be closed.');
  await audit(staff, ticket, 'ticket.close');
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Apply an AI triage suggestion (the copilot's chips). Values are re-validated
 * against the closed lists server-side — the client's claim is never trusted.
 */
export async function applyTriageAction(formData: FormData): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticketId = String(formData.get('ticketId') ?? '');
  const category = String(formData.get('category') ?? '');
  const priority = String(formData.get('priority') ?? '');
  if (
    !(TICKET_CATEGORIES as readonly string[]).includes(category) ||
    !(PRIORITIES as readonly string[]).includes(priority)
  ) {
    throw new Error('Invalid triage values.');
  }
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  requireOpen(ticket);
  await createTicketRepo(getDb()).setTriage(ticket.id, {
    category: category as TicketCategory,
    priority: priority as TicketPriority,
  });
  await audit(staff, ticket, 'ticket.triage', { category, priority, source: 'copilot' });
  revalidatePath('/admin-dashboard', 'layout');
}

/** The staff member discarded an AI draft — audit-only (rung-1 telemetry). */
export async function copilotRejectAction(ticketId: string): Promise<void> {
  const { staff, scope } = await requireTicketWorker();
  const ticket = await getScopedTicket(scope, ticketId);
  assertCanWork(staff, ticket);
  await audit(staff, ticket, 'copilot.reject');
}
