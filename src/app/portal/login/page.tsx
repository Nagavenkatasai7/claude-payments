import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalCustomer, safePortalNext } from '@/lib/portal-auth';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { LoginForm } from './login-form';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.login.title');

/**
 * The partner-branded sign-in (SPEC §2.1): a WhatsApp code from the partner's own number.
 * `?from=account` (one customer portal, Oct 2): the legacy /account sign-in handed this customer over
 * after their password (src/app/account/actions.ts handOffToPortal), so say why. A fixed notice:
 * nothing from the query string is rendered.
 * `?next=` (C1): the page the customer asked for. Only a value on the safePortalNext allow-list is
 * kept (anything else is /portal), and the sign-in actions check it again on the server.
 */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const site = await requirePortalSite();
  const query = await searchParams;
  const next = safePortalNext(typeof query.next === 'string' ? query.next : undefined);
  if (await getPortalCustomer()) redirect(next);
  const fromAccount = query.from === 'account';
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <PageHeader title={t('portal.login.title')} sub={t('portal.login.sub', { brand: site.brand })} />
      {fromAccount ? (
        <p data-from-account role="status" className="rounded-ds-inner border border-ds-border bg-ds-surface px-4 py-3 text-[14px] text-ds-ink">
          {t('portal.login.fromAccount')}
        </p>
      ) : null}
      <Card>
        <LoginForm brand={site.brand} next={next} />
      </Card>
    </div>
  );
}
