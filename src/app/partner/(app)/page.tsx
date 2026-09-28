import Link from 'next/link';
import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ANY } from '@/lib/partner-access';
import { t } from '@/lib/i18n';
import { EmptyState, PageHeader, buttonVariants } from '@/components/ds';

export const metadata: Metadata = { title: t('partner.home.title'), robots: { index: false, follow: false } };

// /partner: the M3-1 home stub. The gate runs on every render (a layout call is never the guard);
// M3-2 adds the shell around it and M3-3 the data.
export default async function PartnerHomePage() {
  await requirePartnerStaff(PARTNER_ANY);
  return (
    <div className="min-h-dvh bg-ds-ground">
      <main id="main" className="sh-main bg-transparent">
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
      </main>
    </div>
  );
}
