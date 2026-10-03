import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, UserX } from 'lucide-react';
import { getDb } from '@/db/client';
import { env } from '@/lib/env';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalPrefs, type PortalPrefs } from '@/lib/portal-prefs';
import { dataRequestStatusCopy } from '@/lib/portal-data-rights';
import { logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';
import type { KycStatus } from '@/lib/types';
import { Button, Card, PageHeader } from '@/components/ds';
import { privacyMetadata } from './request-step';

export const generateMetadata = () => privacyMetadata('portal.privacy.title');

const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const day = (iso: string | Date | null | undefined) => {
  const ms = iso instanceof Date ? iso.getTime() : typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? DAY.format(new Date(ms)) : null;
};

const KYC: Record<KycStatus, MessageKey> = {
  not_started: 'portal.privacy.kyc.not_started',
  pending: 'portal.privacy.kyc.pending',
  verified: 'portal.privacy.kyc.verified',
  rejected: 'portal.privacy.kyc.rejected',
  grandfathered: 'portal.privacy.kyc.grandfathered',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-ds-border py-3 first:border-t-0 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-[14px] text-ds-ink-muted">{label}</dt>
      <dd className="text-[14.5px] font-semibold text-ds-ink">{value}</dd>
    </div>
  );
}

/**
 * Privacy (UI redesign M2-13, Task 13.2), behind CUSTOMER_DATA_RIGHTS_ENABLED (off → 404, and the
 * layout shows no nav item). The customer's consent record, and the two request entry points. SPEC
 * §6b: requests are filed for the compliance team; nothing is exported or erased here.
 */
export default async function PrivacyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePortalSite();
  if (!env.customerDataRightsEnabled) notFound();
  const ctx = await requirePortalCustomer('/portal/privacy');
  const c = ctx.customer;
  const status = dataRequestStatusCopy((await searchParams).status);

  let prefs: PortalPrefs | null = null;
  try {
    prefs = await getPortalPrefs(getDb(), ctx.site.partnerId, ctx.session.phone);
  } catch (err) {
    logWarn('portal.privacy.prefs', err);
  }

  const optIn = day(c.optInAt);
  const optOut = day(c.optedOutAt);
  const whatsapp = optOut
    ? t('portal.privacy.whatsappOff', { date: optOut })
    : optIn
      ? t('portal.privacy.whatsappOn', { date: optIn })
      : t('portal.privacy.notRecorded');
  const phoneVerified = day(c.phoneVerifiedAt);

  return (
    <>
      <PageHeader title={t('portal.privacy.title')} sub={t('portal.privacy.sub')} />
      <div className="flex flex-col gap-6">
        {status ? (
          <p
            role={status.ok ? 'status' : 'alert'}
            className={`rounded-ds-card border p-4 text-[14px] font-semibold ${
              status.ok ? 'border-ds-success-border bg-ds-success-bg text-ds-success-ink' : 'border-ds-danger-border bg-ds-danger-bg text-ds-danger-ink'
            }`}
          >
            {t(status.key)}
          </p>
        ) : null}

        <Card>
          <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.privacy.consentTitle')}</h2>
          <dl className="mt-3">
            <Row label={t('portal.privacy.whatsapp')} value={whatsapp} />
            <Row label={t('portal.privacy.emailReceipts')} value={t(prefs?.emailReceipts ? 'portal.privacy.on' : 'portal.privacy.off')} />
            <Row
              label={t('portal.privacy.emailVerified')}
              value={t(prefs?.emailVerifiedAt ? 'portal.privacy.verified' : 'portal.privacy.notVerified')}
            />
            <Row
              label={t('portal.privacy.phoneVerified')}
              value={phoneVerified ? `${t('portal.privacy.verified')} (${phoneVerified})` : t('portal.privacy.notVerified')}
            />
            <Row label={t('portal.privacy.identity')} value={t(KYC[c.kycStatus] ?? 'portal.privacy.kyc.not_started')} />
          </dl>
        </Card>

        <section aria-labelledby="privacy-requests" className="flex flex-col gap-3">
          <h2 id="privacy-requests" className="text-[18px] font-bold text-ds-ink">
            {t('portal.privacy.requestsTitle')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="flex flex-col gap-3">
              <Download aria-hidden="true" className="size-5 text-ds-primary" />
              <h3 className="font-bold text-ds-ink">{t('portal.privacy.exportTitle')}</h3>
              <p className="text-[14px] text-ds-ink-muted">{t('portal.privacy.exportBody')}</p>
              <div className="mt-auto">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/portal/privacy/export">{t('portal.privacy.start')}</Link>
                </Button>
              </div>
            </Card>
            <Card className="flex flex-col gap-3">
              <UserX aria-hidden="true" className="size-5 text-ds-danger-ink" />
              <h3 className="font-bold text-ds-ink">{t('portal.privacy.deleteTitle')}</h3>
              <p className="text-[14px] text-ds-ink-muted">{t('portal.privacy.deleteBody')}</p>
              <div className="mt-auto">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/portal/privacy/delete">{t('portal.privacy.start')}</Link>
                </Button>
              </div>
            </Card>
          </div>
        </section>
      </div>
    </>
  );
}
