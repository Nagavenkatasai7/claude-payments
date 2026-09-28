import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalCustomer } from '@/lib/portal-auth';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { LoginForm } from './login-form';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.login.title');

/** The partner-branded sign-in (SPEC §2.1): a WhatsApp code from the partner's own number. */
export default async function PortalLoginPage() {
  const site = await requirePortalSite();
  if (await getPortalCustomer()) redirect('/portal');
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <PageHeader title={t('portal.login.title')} sub={t('portal.login.sub', { brand: site.brand })} />
      <Card>
        <LoginForm brand={site.brand} />
      </Card>
    </div>
  );
}
