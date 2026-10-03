import type { ReactNode } from 'react';
import Link from 'next/link';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { resolveKycMode } from '@/lib/partner-config';
import { sendGateActive } from '@/lib/kyc-gate';
import { getCustomerMfaStore, customerKey } from '@/lib/customer-mfa';
import { profileView, recordPortalPiiView } from '@/lib/portal-profile';
import { t } from '@/lib/i18n';
import { Badge, Card, MaskedValue, PageHeader } from '@/components/ds';
import { revealPortalLegalNameAction } from './actions';
import { KycStartForm, MfaEnrolForm } from './profile-forms';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.profile.title', { referrer: 'no-referrer' });

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-[14.5px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-ds-ink">{children}</dd>
    </div>
  );
}

/**
 * Profile & KYC (UI redesign M2-11, Tasks 11.1-11.2). Everything is masked on the server; the legal
 * name is revealed only through the audited action. Every render writes ONE `pii.view` row (awaited,
 * not caught: no identity without a record). The KYC start reuses the /account/verify core.
 */
export default async function ProfilePage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer('/portal/profile');
  const [partner, mfaOn] = await Promise.all([
    getPartnerStore().getPartner(site.partnerId),
    getCustomerMfaStore()
      .isEnrolled(customerKey(ctx.customer))
      .catch(() => false),
  ]);
  const view = profileView(ctx.customer);
  await recordPortalPiiView(getDb(), site.partnerId, ctx.session.phone, view.fields);
  const delegated = resolveKycMode(partner).mode === 'delegated';
  const gateOn = sendGateActive(partner);

  return (
    <>
      <PageHeader title={t('portal.profile.title')} sub={t('portal.profile.sub', { brand: site.brand })} />
      <div className="flex flex-col gap-5">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.profile.detailsTitle')}</h2>
          <dl className="mt-2 divide-y divide-ds-border">
            <Row label={t('portal.profile.phone')}>
              <span className="font-mono tabular-nums">{view.phone}</span>
            </Row>
            <Row label={t('portal.profile.legalName')}>
              {view.legalName ? (
                <MaskedValue masked={view.legalName} reveal={revealPortalLegalNameAction} label={t('portal.profile.legalName')} />
              ) : (
                <span className="text-ds-ink-muted">{t('portal.profile.notOnFile')}</span>
              )}
            </Row>
            <Row label={t('portal.profile.email')}>
              <span className="flex flex-col items-end gap-1">
                {view.email ? <span className="font-mono">{view.email}</span> : <span className="text-ds-ink-muted">{t('portal.profile.notOnFile')}</span>}
                <Link href="/portal/notifications" className="text-[13px] font-semibold text-ds-primary hover:underline">
                  {t('portal.profile.manageEmail')}
                </Link>
              </span>
            </Row>
          </dl>
        </Card>

        <div id="verify" className="scroll-mt-6">
        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.kyc.title')}</h2>
            <Badge tone={view.kyc.tone}>{t(view.kyc.label)}</Badge>
          </div>
          {delegated ? (
            <p className="text-[14px] text-ds-ink-muted">{t('portal.kyc.delegated_body', { brand: site.brand })}</p>
          ) : ctx.customer.kycStatus === 'rejected' ? (
            // Owner decision (2026-09-28): no retry after a rejection in the portal; the customer contacts the partner.
            <p className="text-[14px] text-ds-ink-muted">{t('portal.kyc.rejected_body', { brand: site.brand })}</p>
          ) : view.kyc.canStart && gateOn ? (
            <>
              <p className="text-[14px] text-ds-ink-muted">{t('portal.kyc.start_body')}</p>
              <KycStartForm />
            </>
          ) : view.kyc.canStart ? (
            <p className="text-[14px] text-ds-ink-muted">{t('portal.kyc.not_required_body', { brand: site.brand })}</p>
          ) : null}
        </Card>
        </div>

        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.mfa.title')}</h2>
          {mfaOn ? (
            <p className="text-[14px] text-ds-ink-muted">{t('portal.mfa.on_body')}</p>
          ) : (
            <>
              <p className="text-[14px] text-ds-ink-muted">{t('portal.mfa.off_body', { brand: site.brand })}</p>
              <MfaEnrolForm />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
