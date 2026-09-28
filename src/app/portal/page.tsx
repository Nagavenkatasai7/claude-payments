import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { t } from '@/lib/i18n';
import { EmptyState, PageHeader } from '@/components/ds';

export const metadata: Metadata = { title: t('portal.home.title') };

// Home: a stub until Task 7.2 fills it. The gates run on every render (the layout is never the guard).
export default async function PortalHomePage() {
  const site = await requirePortalSite();
  await requirePortalCustomer();
  return (
    <>
      <PageHeader title={t('portal.home.title')} sub={t('portal.home.sub', { brand: site.brand })} />
      <EmptyState icon={<Wallet className="size-5" />} title={t('portal.home.emptyTitle')} body={t('portal.home.emptyBody')} />
    </>
  );
}
