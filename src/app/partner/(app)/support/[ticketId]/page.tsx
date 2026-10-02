import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { PARTNER_ROUTES } from '../../../routes';
import { PARTNER_TICKET_LEADS } from '@/lib/partner-access';
import { t } from '@/lib/i18n';
import { maskPhoneLast4 } from '@/lib/mask';
import { newRequestKey } from '@/lib/portal-request-key';
import {
  PARTNER_TICKET_STATUSES,
  errName,
  getVisibleTicket,
  isTicketId,
  tenantStaffUsernames,
} from '@/lib/partner-tickets';
import { Badge, Card, PageHeader } from '@/components/ds';
import type { Ticket, TicketMessage } from '@/lib/types';
import { BackLink, TicketStatusBadge, formatWhen, priorityLabel, statusLabel } from '../support-bits';
import { AssignForm, EscalateForm, FollowUpForm, NoteForm, ReplyForm, StatusForm } from './ticket-forms';
import { tenantTicketAssignees } from '@/lib/ticket-assignable';
import { logWarn } from '@/lib/log';

export const metadata: Metadata = { title: t('partner.support.ticketTitle'), robots: { index: false, follow: false } };

// /partner/support/[ticketId] (UI redesign M3-19). The route param is authoritative for the
// TARGET, resolved inside the SESSION tenant with the viewer rules (lib/partner-tickets): a
// customer ticket (admin/support: the tenant's; agent: assigned only) or a Contact SmartRemit
// thread (admin: the tenant's; others: their own). Every miss is notFound(). The customer is
// ••••last4 only: a customer message's author id IS the phone, so it is never rendered. Staff who
// are not this tenant's members (SmartRemit staff) are labelled "SmartRemit", never by username.

type Author = { label: string; mine: boolean };

function authorOf(m: TicketMessage, viewer: string, named: Set<string>): Author {
  if (m.actorType === 'customer') return { label: t('partner.support.from.customer'), mine: false };
  if (m.actorType === 'system') return { label: t('partner.support.from.system'), mine: false };
  if (m.actorId === viewer) return { label: t('partner.support.from.you'), mine: true };
  return { label: named.has(m.actorId) ? m.actorId : t('partner.support.from.platform'), mine: false };
}

function Thread({ messages, viewer, named }: { messages: TicketMessage[]; viewer: string; named: Set<string> }) {
  return (
    <ol className="flex flex-col gap-3" aria-label={t('partner.support.threadTitle')}>
      {messages.map((m) => {
        const a = authorOf(m, viewer, named);
        return (
          <li
            key={m.id}
            className={
              m.internal
                ? 'rounded-ds-inner border border-dashed border-ds-warning-border bg-ds-warning-bg p-4'
                : a.mine
                  ? 'rounded-ds-inner border border-ds-border bg-ds-tint p-4'
                  : 'rounded-ds-inner border border-ds-border bg-ds-surface p-4'
            }
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ds-ink-muted">
              <span className="font-semibold text-ds-ink">{a.label}</span>
              {m.internal ? <Badge tone="warning">{t('partner.support.internalBadge')}</Badge> : null}
              <span>{formatWhen(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ds-ink">{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}

export default async function PartnerTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const { ticketId } = await params;
  if (!isTicketId(ticketId)) notFound();
  const ticket: Ticket | null =
    (await getVisibleTicket(ctx, ticketId, 'customer')) ?? (await getVisibleTicket(ctx, ticketId, 'internal'));
  if (!ticket) notFound();

  const isCustomer = ticket.kind === 'customer';
  // Staff see their team's internal notes on a customer ticket. A Contact SmartRemit thread shows
  // only its visible messages.
  const messages = await createTicketRepo(getDb()).listMessages(ticket.id, { includeInternal: isCustomer });
  const named = await tenantStaffUsernames(
    ctx.partnerId,
    [...messages.filter((m) => m.actorType === 'staff').map((m) => m.actorId), ticket.assignedTo ?? ''],
    (u) => getAuthStore().getStaff(u),
  );
  // Merge plan 2e: admin and support (never an agent) may (re)assign, to the tenant's own eligible
  // staff only (the action re-checks). A failed staff read shows no picker (fixed copy, no error).
  const canAssign = isCustomer && ticket.status !== 'closed' && PARTNER_TICKET_LEADS.roles.includes(ctx.role);
  let assignees: { value: string; label: string }[] | null = null;
  if (canAssign) {
    try {
      assignees = tenantTicketAssignees(await getAuthStore().listStaff(), ctx.partnerId).map((s) => ({
        value: s.username,
        label: s.name && s.name !== s.username ? `${s.name} (${s.username})` : s.username,
      }));
    } catch (err) {
      logWarn('partner.support.assignees', errName(err), { partnerId: ctx.partnerId });
    }
  }
  const currentAssignee = ticket.assignedTo ?? '';
  const assigneeLabel = !ticket.assignedTo
    ? t('partner.support.unassigned')
    : t('partner.support.assignedTo', { name: named.has(ticket.assignedTo) ? ticket.assignedTo : t('partner.support.from.platform') });
  const closed = ticket.status === 'closed';
  const requestKeys = { reply: newRequestKey(), note: newRequestKey(), followUp: newRequestKey() };
  const back = isCustomer
    ? { href: PARTNER_ROUTES.support.href, label: t('partner.support.back') }
    : { href: PARTNER_ROUTES.supportContact.href, label: t('partner.support.backContact') };
  const statusOptions = PARTNER_TICKET_STATUSES.filter((s) => s !== ticket.status).map((s) => ({
    value: s,
    label: statusLabel(s),
  }));

  return (
    <>
      <BackLink href={back.href} label={back.label} />
      <PageHeader
        title={ticket.subject}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {isCustomer ? <span>{t('partner.support.customer', { masked: maskPhoneLast4(ticket.customerPhone) })}</span> : null}
            {isCustomer ? <span>{priorityLabel(ticket.priority)}</span> : null}
            <span>{t('partner.support.updated', { when: formatWhen(ticket.updatedAt) })}</span>
          </span>
        }
        actions={<TicketStatusBadge status={ticket.status} />}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6">
        <Card as="section" className="p-4 sm:p-6">
          <h2 className="mb-4 text-[17px] font-semibold text-ds-ink">{t('partner.support.threadTitle')}</h2>
          {isCustomer && ticket.transferId ? (
            <p className="mb-4 break-all text-[13.5px] text-ds-ink-muted">
              {t('partner.support.transferRef', { id: ticket.transferId })}
            </p>
          ) : null}
          <Thread messages={messages} viewer={ctx.username} named={named} />
        </Card>
        <div className="flex flex-col gap-4">
          {closed ? (
            <Card as="section" className="p-4 sm:p-6">
              <p role="status" className="text-[15px] text-ds-ink-muted">
                {isCustomer ? t('partner.support.closedNote') : t('partner.contact.closed')}
              </p>
            </Card>
          ) : isCustomer ? (
            <>
              <Card as="section" className="p-4 sm:p-6">
                <h2 className="mb-3 text-[17px] font-semibold text-ds-ink">{t('partner.support.replyTitle')}</h2>
                <ReplyForm id={ticket.id} requestKey={requestKeys.reply} withWaiting={ticket.status !== 'waiting_admin'} />
              </Card>
              <Card as="section" className="p-4 sm:p-6">
                <h2 className="mb-3 text-[17px] font-semibold text-ds-ink">{t('partner.support.noteTitle')}</h2>
                <NoteForm id={ticket.id} requestKey={requestKeys.note} />
              </Card>
              {assignees ? (
                <Card as="section" className="p-4 sm:p-6">
                  <h2 className="mb-1 text-[17px] font-semibold text-ds-ink">{t('partner.support.assignTitle')}</h2>
                  <p className="mb-3 text-[14px] text-ds-ink-muted">{assigneeLabel}</p>
                  <AssignForm
                    id={ticket.id}
                    current={assignees.some((a) => a.value === currentAssignee) ? currentAssignee : ''}
                    options={assignees}
                  />
                </Card>
              ) : null}
              <Card as="section" className="p-4 sm:p-6">
                <h2 className="mb-3 text-[17px] font-semibold text-ds-ink">{t('partner.support.escalateTitle')}</h2>
                {ticket.status === 'waiting_admin' ? (
                  <p role="status" className="text-[15px] text-ds-ink-muted">
                    {t('partner.support.escalatedNote')}
                  </p>
                ) : (
                  <EscalateForm id={ticket.id} />
                )}
              </Card>
              {/* An escalated (waiting_admin) ticket is SmartRemit's to move: no partner status change. */}
              {ticket.status === 'waiting_admin' ? null : (
                <Card as="section" className="p-4 sm:p-6">
                  <h2 className="mb-3 text-[17px] font-semibold text-ds-ink">{t('partner.support.statusTitle')}</h2>
                  <StatusForm id={ticket.id} options={statusOptions} />
                </Card>
              )}
            </>
          ) : ticket.openedBy === ctx.username ? (
            <Card as="section" className="p-4 sm:p-6">
              <h2 className="mb-3 text-[17px] font-semibold text-ds-ink">{t('partner.contact.followUpTitle')}</h2>
              <FollowUpForm id={ticket.id} requestKey={requestKeys.followUp} />
            </Card>
          ) : (
            <Card as="section" className="p-4 sm:p-6">
              <p className="text-[15px] text-ds-ink-muted">{t('partner.contact.readOnly')}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
