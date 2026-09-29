import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, LifeBuoy } from 'lucide-react';
import { getPortalSite, requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { listPortalTickets, portalSupportEnabled, portalTicketOwner, ticketStatusView } from '@/lib/portal-tickets';
import { t } from '@/lib/i18n';
import { Badge, Button, EmptyState, PageHeader } from '@/components/ds';

export async function generateMetadata(): Promise<Metadata> {
  return (await getPortalSite()) ? { title: t('portal.help.tickets.title') } : {};
}

const dateFmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The customer's support requests (UI redesign M2-12). The list is (host partner, session phone)
 * scoped in the WHERE: the same phone's requests to another partner never show here.
 */
export default async function PortalTicketsPage() {
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
  const tickets = await listPortalTickets(portalTicketOwner(ctx));
  const newCta = (
    <Button asChild size="md">
      <Link href="/portal/help/tickets/new">{t('portal.help.newCta')}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title={t('portal.help.tickets.title')} sub={t('portal.help.tickets.sub', { brand: site.brand })} actions={tickets.length > 0 ? newCta : undefined} />
      {tickets.length === 0 ? (
        <div data-empty>
          <EmptyState icon={<LifeBuoy className="size-5" />} title={t('portal.help.tickets.emptyTitle')} body={t('portal.help.tickets.emptyBody')} action={newCta} />
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-ds-border overflow-hidden rounded-ds-card border border-ds-border bg-ds-surface">
          {tickets.map((ticket) => {
            const view = ticketStatusView(ticket.status);
            return (
              <li key={ticket.id}>
                <Link
                  href={`/portal/help/tickets/${ticket.id}`}
                  className="flex items-center gap-3 px-4 py-4 hover:bg-ds-ground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ds-focus-ring sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-ds-ink">{ticket.subject}</span>
                    <span className="mt-1 block text-[13px] text-ds-ink-muted">
                      {t('portal.help.tickets.colUpdated')} {dateFmt(ticket.updatedAt)}
                    </span>
                  </span>
                  <Badge tone={view.tone}>{t(view.label)}</Badge>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ds-ink-subtle" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
