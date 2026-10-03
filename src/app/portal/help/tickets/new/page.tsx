import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { portalSupportEnabled, portalTicketOwner, portalTicketTransfers } from '@/lib/portal-tickets';
import { newRequestKey } from '@/lib/portal-request-key';
import { formatMoney } from '@/lib/ui/money';
import { t } from '@/lib/i18n';
import { Card, EmptyState, PageHeader } from '@/components/ds';
import { createPortalTicketAction } from '../actions';
import { NewTicketForm, type TransferChoice } from '../ticket-forms';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.help.new.title');

const dateFmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Start a support request (UI redesign M2-12). The optional transfer select offers only the
 * customer's OWN last 10 transfers on this partner; the action re-validates the choice.
 */
export default async function PortalNewTicketPage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer('/portal/help/tickets/new');
  if (!(await portalSupportEnabled(site.partnerId))) {
    return (
      <>
        <PageHeader title={t('portal.help.new.title')} />
        <EmptyState icon={<LifeBuoy className="size-5" />} title={t('portal.help.supportOffTitle')} body={t('portal.help.supportOffBody', { brand: site.brand })} />
      </>
    );
  }
  const transfers: TransferChoice[] = (await portalTicketTransfers(portalTicketOwner(ctx))).map((tr) => ({
    id: tr.id,
    label: `${tr.recipientName} · ${formatMoney(tr.amountSource ?? tr.amountUsd, tr.sourceCurrency ?? 'USD')} · ${dateFmt(tr.createdAt)}`,
  }));
  return (
    <>
      <PageHeader title={t('portal.help.new.title')} sub={t('portal.help.new.sub')} />
      <p className="mb-5 text-[14px]">
        <Link href="/portal/help/tickets" className="font-semibold text-ds-primary hover:underline">
          {t('portal.help.thread.back')}
        </Link>
      </p>
      <Card>
        <NewTicketForm action={createPortalTicketAction} requestKey={newRequestKey()} transfers={transfers} />
      </Card>
    </>
  );
}
