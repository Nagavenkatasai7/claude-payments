import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerDisclosureConfig } from '@/lib/types';
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { AlertEmailForm, DisclosureForm, SupportPortalForm, type DisclosureValues } from './settings-forms';

export const metadata: Metadata = { title: t('partner.settings.title'), robots: { index: false, follow: false } };

// /partner/settings (partner-dashboard merge, 2f): the customer support portal switch, the channel
// alert email, the Reg E licensing disclosure, and the pricing margin READ-ONLY (owner decision D7:
// the margin decides best-rate routing between partners, so only SmartRemit sets it). Admin only;
// the page gates itself (the layout's gate is chrome only) and reads the SESSION tenant only.
// Platform-only settings (settlement provider, countries, internal name, admin note) are not here
// (D8). Every value is rendered as escaped text. Viewing writes nothing.

const H2 = 'text-[18px] font-extrabold text-ds-ink';
const INTRO = 'mt-1 mb-4 text-[14px] text-ds-ink-muted';

function disclosureValues(d: PartnerDisclosureConfig | undefined): DisclosureValues {
  return {
    licensedEntity: d?.licensedEntity ?? '',
    licenseIds: (d?.licenseIds ?? []).join('\n'),
    phone: d?.phone ?? '',
    website: d?.website ?? '',
    regulatorName: d?.stateRegulator?.name ?? '',
    regulatorPhone: d?.stateRegulator?.phone ?? '',
    regulatorWebsite: d?.stateRegulator?.website ?? '',
    deliveryBusinessDays: d?.deliveryEstimate ? String(d.deliveryEstimate.businessDays) : '',
  };
}

async function marginRows(partnerId: string): Promise<Array<{ corridor: string; marginBps: number | undefined }> | null> {
  try {
    const rates = await createPartnerRateRepo(getDb()).listRatesForPartner(partnerId);
    return rates.map((r) => ({ corridor: `${r.sourceCurrency} → ${r.destinationCurrency}`, marginBps: r.marginBps }));
  } catch (err) {
    logWarn('partner.settings.page', err instanceof Error ? err.name : 'error', { source: 'rates', partnerId });
    return null;
  }
}

export default async function PartnerSettingsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.settings.policy);
  const [partner, margins] = await Promise.all([getPartnerStore().getPartner(ctx.partnerId), marginRows(ctx.partnerId)]);
  const header = <PageHeader title={t('partner.settings.title')} sub={t('partner.settings.sub')} />;
  if (!partner) {
    return (
      <>
        {header}
        <ErrorState />
      </>
    );
  }
  const sc = partner.supportConfig ?? {};

  return (
    <>
      {header}
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.settings.portal.title')}</h2>
          <p className={INTRO}>{t('partner.settings.portal.intro')}</p>
          {/* Absent ⇒ on (PartnerSupportConfig.enableSupportPortal defaults to true). */}
          <SupportPortalForm enabled={sc.enableSupportPortal !== false} />
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.settings.alert.title')}</h2>
          <p className={INTRO}>{t('partner.settings.alert.intro')}</p>
          <AlertEmailForm current={sc.alertEmail ?? ''} />
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.settings.disclosure.title')}</h2>
          <p className={INTRO}>{t('partner.settings.disclosure.intro')}</p>
          <DisclosureForm current={disclosureValues(sc.disclosure)} maxDays={MAX_DELIVERY_BUSINESS_DAYS} />
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.settings.pricing.title')}</h2>
          <p className={INTRO}>{t('partner.settings.pricing.intro')}</p>
          {margins === null ? (
            <ErrorState />
          ) : margins.length === 0 ? (
            <EmptyState title={t('partner.settings.pricing.empty')} />
          ) : (
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 text-[14px]">
              <dt className="font-semibold text-ds-ink-muted">{t('partner.settings.pricing.corridor')}</dt>
              <dd className="justify-self-end font-semibold text-ds-ink-muted">{t('partner.settings.pricing.margin')}</dd>
              {margins.map((m) => (
                <div key={m.corridor} className="contents">
                  <dt className="text-ds-ink">{m.corridor}</dt>
                  <dd className="justify-self-end text-ds-ink tabular-nums">{m.marginBps ?? t('partner.settings.pricing.notSet')}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </>
  );
}
