import Link from 'next/link';
import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { resolveKycMode } from '@/lib/partner-config';
import { t } from '@/lib/i18n';
import { Card, ErrorState, PageHeader, buttonVariants } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { CreateCustomerForm } from './create-form';

export const metadata: Metadata = {
  title: t('partner.customers.create.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * /partner/customers/new (lost-features p2 A5): an admin creates a customer by hand at the SESSION
 * tenant. The owner is read for its countries and KYC mode: `verified` is offered only when the
 * partner runs KYC itself (delegated); otherwise the customer starts as not started and SmartRemit
 * verifies them. The action re-checks all of it. The customer gets no message.
 */
export default async function PartnerNewCustomerPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customersNew.policy);
  const owner = await getPartnerStore().getPartner(ctx.partnerId);
  const header = (
    <PageHeader
      title={t('partner.customers.create.title')}
      sub={t('partner.customers.create.sub')}
      actions={
        <Link href={PARTNER_ROUTES.customers.href} prefetch={false} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
          {t('partner.customers.title')}
        </Link>
      }
    />
  );
  if (!owner || owner.countries.length === 0) {
    return (
      <>
        {header}
        <ErrorState />
      </>
    );
  }
  return (
    <>
      {header}
      <Card as="section" className="max-w-xl p-5 sm:p-6">
        <CreateCustomerForm countries={owner.countries} canVerify={resolveKycMode(owner).mode === 'delegated'} />
      </Card>
    </>
  );
}
