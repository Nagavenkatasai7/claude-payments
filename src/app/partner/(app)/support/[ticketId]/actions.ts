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
  getVisibleTicket,
  isRequestKey,
  parsePartnerTicketStatus,
  parseStaffText,
  staffClaimKey,
  ticketNudgeUrl,
} from '@/lib/partner-tickets';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// /partner/support/[ticketId] actions (UI redesign M3-19): reply, internal note, status. The
// shared /partner action shape: the site-host guard, then the gate (outside any try); the target
// id from the form (any partnerId/partner field is never read); resolved INSIDE the session tenant
// with the legacy worker rules (an agent works only tickets assigned to them; a Contact SmartRemit
// thread is not a customer ticket), and every miss is the same not-found; input validated before
// any write; the write, its outbox nudge and its audit row in ONE transaction. The nudges are the
// ones the platform ticket actions enqueue (same text, same dedupe keys), so a ticket worked on
// both surfaces never double-sends.

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

  try {
    const outcome = await claimOnce(getRedis(), staffClaimKey('reply', ctx.partnerId, ctx.username, requestKey), async () =>
      getDb().transaction(async (tx) => {
        const repo = createTicketRepo(tx);
        const msg = await repo.appendMessage({
          ticketId: ticket.id,
          actorType: 'staff',
          actorId: ctx.username,
          body,
          internal: false,
        });
        if (waiting) await repo.updateStatus(ticket.id, 'pending');
        if (ticket.customerPhone) {
          await createOutboxRepo(tx).enqueue(
            'whatsapp.text',
            {
              to: ticket.customerPhone,
              body: `You have a new reply from support — view it in your SmartRemit dashboard: ${ticketNudgeUrl(ticket.id)}`,
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
          meta: { actorScope: 'partner', waiting },
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
    const outcome = await claimOnce(getRedis(), staffClaimKey('note', ctx.partnerId, ctx.username, requestKey), async () =>
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
 * move and anything out of closed (terminal); a refusal writes nothing. Resolving enqueues the
 * once-only resolve nudge (deduped on the ticket id, as the platform action does).
 */
export async function setStatusAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket) return notFound();
  const status = parsePartnerTicketStatus(formData.get('status'));
  if (!status) return { ok: false, error: t('partner.support.statusInvalid') };

  let nudged = false;
  try {
    await getDb().transaction(async (tx) => {
      const updated = await createTicketRepo(tx).updateStatus(ticket.id, status);
      if (!updated) throw new StatusRefusedError();
      if (status === 'resolved' && ticket.customerPhone) {
        nudged = await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          {
            to: ticket.customerPhone,
            body: `Your support request has been resolved — view it in your SmartRemit dashboard: ${ticketNudgeUrl(ticket.id)}`,
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
        meta: { actorScope: 'partner', status },
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
