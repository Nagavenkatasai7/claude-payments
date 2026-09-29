import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer, safePortalNext } from '@/lib/portal-auth';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { StepUpForm } from './step-up-form';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.verify.title');

/** The 15-minute step-up (a fresh WhatsApp code, plus TOTP when enrolled). `next` is allow-listed. */
export default async function PortalVerifyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePortalSite();
  await requirePortalCustomer();
  const raw = (await searchParams).next;
  const next = safePortalNext(typeof raw === 'string' ? raw : undefined);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <PageHeader title={t('portal.verify.title')} sub={t('portal.verify.sub')} />
      <Card>
        <StepUpForm next={next} />
      </Card>
    </div>
  );
}
