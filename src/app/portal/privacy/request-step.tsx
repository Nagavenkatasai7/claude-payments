import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { env } from '@/lib/env';
import { requirePortalSite } from '@/lib/portal-site';
import { portalMetadata } from '@/lib/portal-metadata';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { newRequestKey } from '@/lib/portal-request-key';
import { DEFAULT_REASON_MIN } from '@/lib/ui/confirm-reason';
import type { DataRequestKind } from '@/lib/portal-data-rights';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Card, ConfirmDialog, PageHeader } from '@/components/ds';
import { requestDataAction } from './actions';

/**
 * The privacy pages' metadata: the title only when the page can render (a portal site AND the flag
 * on). Otherwise empty, so a 404 on the apex or with the flag off carries nothing page-specific.
 */
export async function privacyMetadata(title: MessageKey): Promise<Metadata> {
  return env.customerDataRightsEnabled ? portalMetadata(title) : {};
}

const COPY = {
  export: { title: 'portal.privacy.exportTitle', body: 'portal.privacy.exportBody', confirm: 'portal.privacy.confirmExportTitle' },
  delete: { title: 'portal.privacy.deleteTitle', body: 'portal.privacy.deleteBody', confirm: 'portal.privacy.confirmDeleteTitle' },
} as const;

/**
 * Step 1 of a data request (UI redesign M2-13, Task 13.2): the gates (host, flag, fresh step-up),
 * then the retention copy, then step 2, the ConfirmDialog with a typed reason. The action re-checks
 * every gate and the reason itself; this page is never the guard.
 */
export async function RequestStep({ kind }: { kind: DataRequestKind }) {
  await requirePortalSite();
  if (!env.customerDataRightsEnabled) notFound();
  await requireFreshPortalAuth('/portal/privacy');
  const copy = COPY[kind];
  const action = requestDataAction.bind(null, kind, newRequestKey());

  return (
    <>
      <PageHeader title={t(copy.title)} sub={t(copy.body)} />
      <div className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <p data-retention className="text-[15px] leading-relaxed text-ds-ink">
            {t('portal.privacy.retention')}
          </p>
          <div className="flex flex-wrap gap-3">
            <ConfirmDialog
              trigger={
                <Button type="button" variant={kind === 'delete' ? 'danger' : 'primary'} size="md">
                  {t('portal.privacy.continue')}
                </Button>
              }
              title={t(copy.confirm)}
              body={t('portal.privacy.confirmBody')}
              confirmLabel={t('portal.privacy.submit')}
              reasonMin={DEFAULT_REASON_MIN}
              action={action}
              destructive={kind === 'delete'}
            />
            <Button asChild variant="ghost" size="md">
              <Link href="/portal/privacy">
                <ArrowLeft aria-hidden="true" className="size-4" />
                {t('portal.privacy.back')}
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
