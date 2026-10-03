'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ADMIN, type PartnerCtx } from '@/lib/partner-access';
import {
  StatusRefusedError,
  canAnswerTeamQuestion,
  claimOnce,
  errName,
  getVisibleTicket,
  isRequestKey,
  isTeamQuestion,
  parseStaffText,
  parseTeamQuestionStatus,
  staffClaimKey,
} from '@/lib/partner-tickets';
import type { Ticket } from '@/lib/types';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// Lost-features A12: a partner admin answers, resolves or closes a TEAM question (an internal thread
// one of their own staff addressed to the tenant's admins). The shared /partner action shape: the
// site-host guard, then the admin gate (outside any try); the target is re-read inside the SESSION
// tenant, and canAnswerTeamQuestion is the whole decision (a missing thread, another tenant's, a
// thread addressed to SmartRemit, or one the admin opened themselves is the same not-found). The
// write and its audit row commit in ONE transaction, under the audit names of the legacy
// employee-questions actions.

const failed = (): ActionResult => ({ ok: false, error: t('partner.support.failed') });
const notFound = (): ActionResult => ({ ok: false, error: t('partner.support.notFound') });

/** The team question this admin may work, a fixed refusal, or null (not found). */
async function workableQuestion(
  ctx: PartnerCtx,
  formData: FormData,
): Promise<{ ticket: Ticket } | { refusal: ActionResult }> {
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'internal');
  if (ticket && isTeamQuestion(ticket) && ticket.openedBy !== ctx.username && ticket.status === 'closed') {
    return { refusal: { ok: false, error: t('partner.contact.closed') } };
  }
  if (!ticket || !canAnswerTeamQuestion(ctx, ticket)) return { refusal: notFound() };
  return { ticket };
}

function refresh(ticketId: string): void {
  revalidatePath(PARTNER_ROUTES.supportContact.href);
  revalidatePath(`${PARTNER_ROUTES.support.href}/${ticketId}`);
}

export async function answerTeamQuestionAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const target = await workableQuestion(ctx, formData);
  if ('refusal' in target) return target.refusal;
  const { ticket } = target;
  const body = parseStaffText(formData.get('body'));
  if (!body) return { ok: false, error: t('partner.support.textInvalid') };
  const requestKey = formData.get('requestKey');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.support.expired') };

  try {
    const claim = staffClaimKey('team-answer', ctx.partnerId, ctx.username, requestKey, `${ticket.id}|${body}`);
    const outcome = await claimOnce(getRedis(), claim, async () =>
      getDb().transaction(async (tx) => {
        const msg = await createTicketRepo(tx).appendMessage({
          ticketId: ticket.id,
          actorType: 'staff',
          actorId: ctx.username,
          body,
          internal: false,
        });
        await createAuditRepo(tx).record({
          partnerId: ctx.partnerId,
          actor: ctx.username,
          actorType: 'staff',
          action: 'employee_question.answer',
          subjectId: ticket.id,
          meta: { actorScope: 'partner' },
        });
        return String(msg.id);
      }),
    );
    if (outcome.status === 'inflight') return { ok: false, error: t('partner.support.inFlight') };
  } catch (err) {
    logWarn('partner.support.team_answer', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}

export async function setTeamQuestionStatusAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const target = await workableQuestion(ctx, formData);
  if ('refusal' in target) return target.refusal;
  const { ticket } = target;
  const status = parseTeamQuestionStatus(formData.get('status'));
  if (!status) return { ok: false, error: t('partner.contact.statusRefused') };

  try {
    await getDb().transaction(async (tx) => {
      // Guarded: closed is terminal and a same-state move is refused (null).
      const updated = await createTicketRepo(tx).updateStatus(ticket.id, status, { notFrom: ['waiting_admin'] });
      if (!updated) throw new StatusRefusedError();
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'employee_question.status',
        subjectId: ticket.id,
        meta: { actorScope: 'partner', status, from: ticket.status },
      });
    });
  } catch (err) {
    if (err instanceof StatusRefusedError) return { ok: false, error: t('partner.contact.statusRefused') };
    logWarn('partner.support.team_status', errName(err), { ticketId: ticket.id });
    return failed();
  }
  refresh(ticket.id);
  return { ok: true };
}
