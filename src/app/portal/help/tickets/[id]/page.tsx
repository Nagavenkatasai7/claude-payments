import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LifeBuoy } from 'lucide-react';
import { getPortalSite, requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalTicket, listPortalTicketMessages, portalSupportEnabled, portalTicketOwner, ticketStatusView } from '@/lib/portal-tickets';
import { newRequestKey } from '@/lib/portal-request-key';
import { t } from '@/lib/i18n';
import { dsCn } from '@/lib/ui/ds-cn';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ds';
import { replyPortalTicketAction } from '../actions';
import { ReplyForm } from '../ticket-forms';

export async function generateMetadata(): Promise<Metadata> {
  return (await getPortalSite()) ? { title: t('portal.help.tickets.title') } : {};
}

const dateFmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const stampFmt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * One support conversation (UI redesign M2-12). Ownership is (host partner, session phone) in the
 * WHERE: another partner's or customer's ticket, an internal one and a missing id are the same 404.
 * Internal staff notes are excluded in the WHERE; staff lines show as "Support", never a staff id.
 */
export default async function PortalTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  if (!(await portalSupportEnabled(site.partnerId))) {
    return (
      <>
        <PageHeader title={t('portal.help.tickets.title')} />
        <EmptyState icon={<LifeBuoy className="size-5" />} title={t('portal.help.supportOffTitle')} body={t('portal.help.supportOffBody', { brand: site.brand })} />
      </>
    );
  }
  const { id } = await params;
  const ticket = await getPortalTicket(portalTicketOwner(ctx), id);
  if (!ticket) notFound();
  const messages = await listPortalTicketMessages(ticket.id);
  const view = ticketStatusView(ticket.status);
  const closed = ticket.status === 'closed';

  return (
    <>
      {/* A 120-character subject with no spaces must still wrap at 375 px. */}
      <div className="min-w-0 [&_.sh-page-title]:[overflow-wrap:anywhere]">
        <PageHeader
          title={ticket.subject}
          sub={t('portal.help.thread.started', { date: dateFmt(ticket.createdAt) })}
          actions={<Badge tone={view.tone}>{t(view.label)}</Badge>}
        />
      </div>
      <div className="flex flex-col gap-5">
        <p className="flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
          <Link href="/portal/help/tickets" className="font-semibold text-ds-primary hover:underline">
            {t('portal.help.thread.back')}
          </Link>
          {ticket.transferId ? (
            <Link href={`/portal/transfers/${encodeURIComponent(ticket.transferId)}`} className="font-semibold text-ds-primary hover:underline">
              {t('portal.help.thread.transferLink')}
            </Link>
          ) : null}
        </p>

        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <ol className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <li
                key={`${i}-${m.createdAt}`}
                className={dsCn(
                  'max-w-[88%] rounded-ds-inner border px-4 py-3',
                  m.mine ? 'ml-auto border-ds-border bg-ds-tint' : 'mr-auto border-ds-border bg-ds-ground',
                )}
              >
                <p className="mb-1 text-[12.5px] font-semibold text-ds-ink-muted">{m.mine ? t('portal.help.thread.you') : t('portal.help.thread.support')}</p>
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ds-ink">{m.body}</p>
                <p className="mt-1 text-right text-[12px] text-ds-ink-muted">
                  <time dateTime={m.createdAt}>{stampFmt(m.createdAt)}</time>
                </p>
              </li>
            ))}
          </ol>
        </Card>

        {closed ? (
          <p className="text-[14px] text-ds-ink-muted">{t('portal.help.thread.closedNote')}</p>
        ) : (
          <Card>
            <ReplyForm action={replyPortalTicketAction.bind(null, ticket.id)} requestKey={newRequestKey()} />
          </Card>
        )}
      </div>
    </>
  );
}
