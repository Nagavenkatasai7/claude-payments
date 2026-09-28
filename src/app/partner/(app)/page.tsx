import Link from 'next/link';
import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ROUTES } from '../routes';
import { t } from '@/lib/i18n';
import { EmptyState, PageHeader, buttonVariants } from '@/components/ds';

export const metadata: Metadata = { title: t('partner.home.title'), robots: { index: false, follow: false } };

// /partner: the home stub inside the M3-2 shell (the layout owns the main landmark). The gate runs on every
// render (the layout's call is never the guard); M3-3 adds the data.
export default async function PartnerHomePage() {
  await requirePartnerStaff(PARTNER_ROUTES.home.policy);
  return (
    <>
    <PageHeader title={t('partner.home.title')} sub={t('partner.home.sub')} />
    <EmptyState
      icon={<ShieldCheck className="size-5" />}
      title={t('partner.home.emptyTitle')}
      body={t('partner.home.emptyBody')}
      action={
        <Link href="/partner/security" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
          {t('partner.home.securityLink')}
        </Link>
      }
    />
    </>
  );
}
