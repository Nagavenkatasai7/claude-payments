'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { newTransferId } from '@/lib/id';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import {
  CONTACT_OPEN_CAP,
  CapReachedError,
  claimOnce,
  errName,
  getVisibleTicket,
  isRequestKey,
  isTicketId,
  listTenantTickets,
  parseContactBody,
  parseContactSubject,
  parseStaffText,
  staffClaimKey,
  withUserLock,
} from '@/lib/partner-tickets';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// "Contact SmartRemit" (UI redesign M3-19): a partner staff member opens a thread with the
// SmartRemit team. It is an INTERNAL ticket (kind 'internal', like the platform's
// employee-questions flow), so it appears in the platform employee-questions queue and never on a
// customer surface. The tenant and the opener come from the SESSION only (a partnerId/partner field
// in the form is never read). Only the opener adds follow-ups (the legacy opener-only rule).

const OPEN_STATUSES = new Set(['open', 'pending', 'waiting_admin']);
const failed = (): ActionResult => ({ ok: false, error: t('partner.support.failed') });

export async function contactSmartRemitAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.supportContact.policy);
  const subject = parseContactSubject(formData.get('subject'));
  if (!subject) return { ok: false, error: t('partner.contact.subjectInvalid') };
  const message = parseContactBody(formData.get('message'));
  if (!message) return { ok: false, error: t('partner.contact.messageInvalid') };
  const requestKey = formData.get('requestKey');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.support.expired') };

  const claim = staffClaimKey('contact', ctx.partnerId, ctx.username, requestKey, JSON.stringify([subject, message]));
  let ticketId: string;
  try {
    const redis = getRedis();
    // A replay of a submit that already created its thread lands on that thread (no cap check).
    const prior = await redis.get(claim);
    const isReplay = typeof prior === 'string' && prior.startsWith('d:');
    // The cap check and the create run under a per-user lock, so parallel submits with fresh
    // request keys cannot all pass the check before any insert commits.
    const run = () =>
      claimOnce(redis, claim, async () => {
        if (!isReplay) {
          const mine = await listTenantTickets(ctx.partnerId, { kind: 'internal', limit: 500 });
          const open = mine.filter((x) => x.openedBy === ctx.username && OPEN_STATUSES.has(x.status)).length;
          if (open >= CONTACT_OPEN_CAP) throw new CapReachedError();
        }
        return create();
      });
    const create = () =>
      getDb().transaction(async (tx) => {
        const id = `tk_${newTransferId()}`;
        await createTicketRepo(tx).createTicket({
          id,
          partnerId: ctx.partnerId,
          kind: 'internal',
          openedBy: ctx.username,
          subject,
          body: message,
        });
        await createAuditRepo(tx).record({
          partnerId: ctx.partnerId,
          actor: ctx.username,
          actorType: 'staff',
          action: 'ticket.contact.open',
          subjectId: id,
          meta: { actorScope: 'partner' },
        });
        return id;
      });
    const locked = isReplay ? { locked: true as const, value: await run() } : await withUserLock(redis, 'contact', ctx.partnerId, ctx.username, run);
    if (!locked.locked) return { ok: false, error: t('partner.support.inFlight') };
    const outcome = locked.value;
    if (outcome.status === 'inflight') return { ok: false, error: t('partner.support.inFlight') };
    if (!isTicketId(outcome.value)) return failed();
    ticketId = outcome.value;
  } catch (err) {
    if (err instanceof CapReachedError) return { ok: false, error: t('partner.contact.cap') };
    logWarn('partner.support.contact', errName(err), {});
    return failed();
  }
  revalidatePath(PARTNER_ROUTES.supportContact.href);
  // Outside any try: redirect() throws by design.
  redirect(`${PARTNER_ROUTES.support.href}/${ticketId}`);
}

export async function contactFollowUpAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.supportContact.policy);
  const notFound: ActionResult = { ok: false, error: t('partner.support.notFound') };
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'internal');
  // Opener-only, whatever the role (an admin may read the tenant's threads, not post in them).
  if (!ticket || ticket.openedBy !== ctx.username) return notFound;
  if (ticket.status === 'closed') return { ok: false, error: t('partner.contact.closed') };
  const body = parseStaffText(formData.get('body'));
  if (!body) return { ok: false, error: t('partner.support.textInvalid') };
  const requestKey = formData.get('requestKey');
  if (!isRequestKey(requestKey)) return { ok: false, error: t('partner.support.expired') };

  try {
    const outcome = await claimOnce(getRedis(), staffClaimKey('contact-reply', ctx.partnerId, ctx.username, requestKey, `${ticket.id}|${body}`), async () =>
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
          action: 'ticket.contact.reply',
          subjectId: ticket.id,
          meta: { actorScope: 'partner' },
        });
        return String(msg.id);
      }),
    );
    if (outcome.status === 'inflight') return { ok: false, error: t('partner.support.inFlight') };
  } catch (err) {
    logWarn('partner.support.contact_reply', errName(err), { ticketId: ticket.id });
    return failed();
  }
  revalidatePath(PARTNER_ROUTES.supportContact.href);
  revalidatePath(`${PARTNER_ROUTES.support.href}/${ticket.id}`);
  return { ok: true };
}
