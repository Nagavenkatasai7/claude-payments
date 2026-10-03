'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { getRedis } from '@/lib/redis';
import { pokeWorker } from '@/lib/outbox';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import {
  StatusRefusedError,
  claimOnce,
  errName,
  escalationNote,
  getVisibleTicket,
  isRequestKey,
  parseAssigneeField,
  parseEscalationReason,
  parsePartnerTicketStatus,
  parseStaffText,
  staffClaimKey,
  ticketNudgeUrl,
} from '@/lib/partner-tickets';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_TICKET_LEADS } from '@/lib/partner-access';
import { scopeOf } from '@/lib/staff-scope';
import { isTenantTicketAssignee } from '@/lib/ticket-assignable';
import type { Staff } from '@/lib/types';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';
import { ticketReplyNudge, ticketResolvedNudge } from '@/lib/ticket-nudge';

// /partner/support/[ticketId] actions (UI redesign M3-19): reply, internal note, status. The
// shared /partner action shape: the site-host guard, then the gate (outside any try); the target
// id from the form (any partnerId/partner field is never read); resolved INSIDE the session tenant
// with the legacy worker rules (an agent works only tickets assigned to them; a Contact SmartRemit
// thread is not a customer ticket), and every miss is the same not-found; input validated before
// any write; the write, its outbox nudge and its audit row in ONE transaction. The nudges are the
// ones the platform ticket actions enqueue (same text from ticket-nudge.ts, same dedupe keys), so a
// ticket worked on both surfaces never double-sends.

/** Statuses a partner may not move a ticket out of (the platform escalation is SmartRemit's). */
const PARTNER_LOCKED_STATUSES = ['waiting_admin'] as const;

const notFound = (): ActionResult => ({ ok: false, error: t('partner.support.notFound') });
const failed = (): ActionResult => ({ ok: false, error: t('partner.support.failed') });

function refresh(ticketId: string): void {
  revalidatePath(PARTNER_ROUTES.support.href);
  revalidatePath(`${PARTNER_ROUTES.support.href}/${ticketId}`);
}

/** A customer-visible staff reply (+ the WhatsApp nudge to the owning tenant's customer). */
export async function replyAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  if (ticket.status === 'closed') return { ok: false, error: t('partner.support.closed') };
  const body = parseStaffText(formData.get('body'));
  if (!body) return { ok: false, error: t('partner.support.textInvalid') };
  const waiting = formData.get('waiting') === 'on';
  const requestKey = formData.get('requestKey');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.support.expired') };

  const nudgeUrl = ticket.customerPhone ? await ticketNudgeUrl(ticket.partnerId, ticket.id) : '';
  try {
    const outcome = await claimOnce(getRedis(), staffClaimKey('reply', ctx.partnerId, ctx.username, requestKey, `${ticket.id}|${waiting}|${body}`), async () =>
      getDb().transaction(async (tx) => {
        const repo = createTicketRepo(tx);
        const msg = await repo.appendMessage({
          ticketId: ticket.id,
          actorType: 'staff',
          actorId: ctx.username,
          body,
          internal: false,
        });
        // "Waiting on customer" never de-escalates: an escalated (waiting_admin) ticket keeps its
        // status (checked atomically in the UPDATE); the reply itself is still posted.
        const movedToPending = waiting
          ? (await repo.updateStatus(ticket.id, 'pending', { notFrom: PARTNER_LOCKED_STATUSES })) !== null
          : false;
        if (ticket.customerPhone) {
          await createOutboxRepo(tx).enqueue(
            'whatsapp.text',
            {
              to: ticket.customerPhone,
              body: ticketReplyNudge(nudgeUrl),
              // The ticket's own tenant (a repo value, never a form field); creds resolve at drain.
              partnerId: ticket.partnerId,
              category: 'nonessential',
            },
            { dedupeKey: `ticketmsg:${ticket.id}:${msg.id}` },
          );
        }
        await createAuditRepo(tx).record({
          partnerId: ctx.partnerId,
          actor: ctx.username,
          actorType: 'staff',
          action: 'ticket.reply',
          subjectId: ticket.id,
          meta: { actorScope: 'partner', waiting: movedToPending },
        });
        return String(msg.id);
      }),
    );
    if (outcome.status === 'inflight') return { ok: false, error: t('partner.support.inFlight') };
    if (outcome.status === 'ran') pokeWorker();
  } catch (err) {
    // The error NAME only: a failed query's message carries its bound params (the reply text).
    logWarn('partner.support.reply', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}

/** A staff-only internal note: never shown to the customer, never nudges. */
export async function internalNoteAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  if (ticket.status === 'closed') return { ok: false, error: t('partner.support.closed') };
  const body = parseStaffText(formData.get('body'));
  if (!body) return { ok: false, error: t('partner.support.textInvalid') };
  const requestKey = formData.get('requestKey');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.support.expired') };

  try {
    const outcome = await claimOnce(getRedis(), staffClaimKey('note', ctx.partnerId, ctx.username, requestKey, `${ticket.id}|${body}`), async () =>
      getDb().transaction(async (tx) => {
        const msg = await createTicketRepo(tx).appendMessage({
          ticketId: ticket.id,
          actorType: 'staff',
          actorId: ctx.username,
          body,
          internal: true,
        });
        await createAuditRepo(tx).record({
          partnerId: ctx.partnerId,
          actor: ctx.username,
          actorType: 'staff',
          action: 'ticket.note',
          subjectId: ticket.id,
          meta: { actorScope: 'partner' },
        });
        return String(msg.id);
      }),
    );
    if (outcome.status === 'inflight') return { ok: false, error: t('partner.support.inFlight') };
  } catch (err) {
    logWarn('partner.support.note', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}

/**
 * Move a customer ticket to open / pending / resolved / closed. The repo guard refuses a same-state
 * move and anything out of closed (terminal), and this action refuses any move out of waiting_admin
 * (the platform escalation); a refusal writes nothing. Resolving enqueues the
 * once-only resolve nudge (deduped on the ticket id, as the platform action does).
 */
export async function setStatusAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  // An escalation (waiting_admin) is SmartRemit's to handle: a partner cannot move it out.
  if (ticket.status === 'waiting_admin') return { ok: false, error: t('partner.support.statusRefused') };
  const status = parsePartnerTicketStatus(formData.get('status'));
  if (!status) return { ok: false, error: t('partner.support.statusInvalid') };

  let nudged = false;
  const nudgeUrl = status === 'resolved' && ticket.customerPhone ? await ticketNudgeUrl(ticket.partnerId, ticket.id) : '';
  try {
    await getDb().transaction(async (tx) => {
      const updated = await createTicketRepo(tx).updateStatus(ticket.id, status, { notFrom: PARTNER_LOCKED_STATUSES });
      if (!updated) throw new StatusRefusedError();
      if (status === 'resolved' && ticket.customerPhone) {
        nudged = await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          {
            to: ticket.customerPhone,
            body: ticketResolvedNudge(nudgeUrl),
            partnerId: ticket.partnerId,
            category: 'nonessential',
          },
          { dedupeKey: `ticketresolved:${ticket.id}` },
        );
      }
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'ticket.status',
        subjectId: ticket.id,
        meta: { actorScope: 'partner', status, from: ticket.status },
      });
    });
  } catch (err) {
    if (err instanceof StatusRefusedError) return { ok: false, error: t('partner.support.statusRefused') };
    logWarn('partner.support.status', errName(err), { ticketId: ticket.id });
    return failed();
  }
  if (nudged) pokeWorker();
  refresh(ticket.id);
  return { ok: true };
}

/** Thrown inside the assign transaction when the compare-and-set loses (rolls it back). */
class AssignRaceError extends Error {
  constructor() {
    super('Assignment changed');
    this.name = 'AssignRaceError';
  }
}

/**
 * (Re)assign or unassign a customer ticket (merge plan 2e; ported from the legacy
 * assignTicketAction). Admin and support only: an agent is bounced by the gate (PARTNER_TICKET_LEADS).
 * The assignee must be an active, ticket-capable MEMBER of the session tenant
 * (isTenantTicketAssignee: never another tenant's staff, never a SmartRemit account); every refusal
 * is one fixed message. The write is a compare-and-set on the assignee this request read, so a
 * double submit or a concurrent reassignment never writes twice; the same assignee again is a no-op.
 */
export async function assignAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_TICKET_LEADS);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  if (ticket.status === 'closed') return { ok: false, error: t('partner.support.closed') };
  const parsed = parseAssigneeField(formData.get('assignee'));
  if (!parsed.ok) return { ok: false, error: t('partner.support.assigneeInvalid') };
  const { assignee } = parsed;
  if (assignee !== null) {
    let staff: Staff | null = null;
    try {
      staff = await getAuthStore().getStaff(assignee);
    } catch {
      staff = null; // An unreadable record is not assignable (fail closed).
    }
    if (!isTenantTicketAssignee(staff, ctx.partnerId)) return { ok: false, error: t('partner.support.assigneeInvalid') };
  }
  const from = ticket.assignedTo ?? null;
  if (from === assignee) return { ok: true };

  try {
    await getDb().transaction(async (tx) => {
      const updated = await createTicketRepo(tx).assign(ticket.id, assignee, { from });
      if (!updated) throw new AssignRaceError();
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'ticket.assign',
        subjectId: ticket.id,
        meta: { actorScope: scopeOf(ctx.staff).kind, assignee },
      });
    });
  } catch (err) {
    if (err instanceof AssignRaceError) {
      // Lost the compare-and-set: already this assignee (a double submit) is success; anything
      // else (closed meanwhile, reassigned by someone else) asks for a reload. Nothing was written.
      const now = await getVisibleTicket(ctx, ticket.id, 'customer').catch(() => null);
      if (now && now.status !== 'closed' && (now.assignedTo ?? null) === assignee) return { ok: true };
      return { ok: false, error: t('partner.support.assignStale') };
    }
    logWarn('partner.support.assign', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}

/**
 * Escalate a customer ticket to SmartRemit (merge plan 2e; ported from the legacy escalateAction):
 * the status moves to waiting_admin (the platform queue) and an internal system note carries the
 * typed reason, with ONE audit row, all in one transaction. Same worker rules as reply (an agent
 * works only tickets assigned to them). A ticket already escalated is refused by the guarded status
 * move, so a repeat writes nothing. The reason stays in the sealed note, never the audit meta.
 */
export async function escalateAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  if (ticket.status === 'closed') return { ok: false, error: t('partner.support.closed') };
  const alreadyEscalated: ActionResult = { ok: false, error: t('partner.support.alreadyEscalated') };
  if (ticket.status === 'waiting_admin') return alreadyEscalated;
  const parsed = parseEscalationReason(formData.get('reason'));
  if (!parsed.ok) {
    return { ok: false, error: t(parsed.error === 'number' ? 'partner.support.reasonHasNumber' : 'partner.support.reasonTooShort') };
  }

  try {
    await getDb().transaction(async (tx) => {
      const repo = createTicketRepo(tx);
      // Refuses closed and an already-escalated ticket atomically (same-state move).
      if (!(await repo.updateStatus(ticket.id, 'waiting_admin'))) throw new StatusRefusedError();
      await repo.appendMessage({
        ticketId: ticket.id,
        actorType: 'system',
        actorId: 'system',
        body: escalationNote(parsed.reason),
        internal: true,
      });
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'ticket.escalate',
        subjectId: ticket.id,
        meta: { actorScope: scopeOf(ctx.staff).kind, from: ticket.status },
      });
    });
  } catch (err) {
    if (err instanceof StatusRefusedError) return alreadyEscalated;
    logWarn('partner.support.escalate', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}
