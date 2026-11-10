import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { setupView, type SetupView } from '@/lib/partner-setup-view';
import { MAX_DELIVERY_BUSINESS_DAYS, resolvePartnerDisclosure } from '@/lib/partner-config';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerDisclosureConfig } from '@/lib/types';
import { Badge, Card, EmptyState, ErrorState, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { AlertEmailForm, ComplianceAlertEmailForm, DisclosureForm, SupportPortalForm, type DisclosureValues } from './settings-forms';

export const metadata: Metadata = { title: t('partner.settings.title'), robots: { index: false, follow: false } };

// /partner/settings (partner-dashboard merge, 2f): the customer support portal switch, the channel
// alert email, the Reg E licensing disclosure, and the pricing margin READ-ONLY (owner decision D7:
// the margin decides best-rate routing between partners, so only SmartRemit sets it). Admin only;
// the page gates itself (the layout's gate is chrome only) and reads the SESSION tenant only.
// Platform-only settings (settlement provider, countries, internal name, admin note) are not here
// (D8). Every value is rendered as escaped text. Viewing writes nothing.
// Lost-features p3 B13: a read-only "Compliance setup" card first (KYC mode, verify-before-send, the
// live-rail warning, countries, and the fixed sanctions line). Admin only, like the page (owner
// line: agents no longer see these facts).
// Fix pack 4 T6 (C23): the disclosure card shows the block's approval state ('Approved by <username>
// on <date>' or 'Not approved') and, when the VIEWER has no two-step sign-in, how to approve it (a
// partner admin's save approves only with TOTP enrolled). A failed enrolment read counts as not
// enrolled (logged by error name only).

const H2 = 'text-[18px] font-extrabold text-ds-ink';
const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

async function viewerEnrolled(username: string, partnerId: string): Promise<boolean> {
  try {
    return await staffMfaEnrolled(username);
  } catch (err) {
    logWarn('partner.settings.page', err instanceof Error ? err.name : 'error', { source: 'mfa', partnerId });
    return false;
  }
}
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

async function paymentConfig(partnerId: string): Promise<Pick<PartnerIntegrations, 'payment'> | null> {
  try {
    return await getPartnerIntegrationsStore().getIntegrations(partnerId);
  } catch (err) {
    logWarn('partner.settings.page', err instanceof Error ? err.name : 'error', { source: 'integrations', partnerId });
    return null;
  }
}

function SetupCard({ view }: { view: SetupView }) {
  const row = 'flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0';
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className={H2}>{t('partner.settings.setup.title')}</h2>
      <p className={INTRO}>{t('partner.settings.setup.intro')}</p>
      <dl data-testid="settings-setup" className="divide-y divide-ds-border text-[14px]">
        <div className={row}>
          <dt className="font-semibold text-ds-ink-muted">{t('partner.settings.setup.kycMode')}</dt>
          <dd className="text-ds-ink" data-setup="kycMode" data-value={view.kycMode}>
            {view.kycMode === 'delegated' ? t('partner.settings.setup.kycDelegated') : t('partner.settings.setup.kycOurs')}
          </dd>
        </div>
        <div className={row}>
          <dt className="font-semibold text-ds-ink-muted">{t('partner.settings.setup.gate')}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-ds-ink" data-setup="gate" data-value={view.verifyBeforeSend ? 'on' : 'off'}>
            {view.verifyBeforeSend ? t('partner.settings.setup.gateOn') : t('partner.settings.setup.gateOff')}
            {view.liveRailWarning === true ? (
              <Badge tone="warning">
                <span data-setup="liveRailWarning">{t('partner.settings.setup.liveRailWarning')}</span>
              </Badge>
            ) : null}
          </dd>
        </div>
        <div className={row}>
          <dt className="font-semibold text-ds-ink-muted">{t('partner.settings.setup.countries')}</dt>
          <dd className="text-ds-ink" data-setup="countries">
            {view.countries.length > 0 ? view.countries.join(', ') : t('partner.settings.setup.noCountries')}
          </dd>
        </div>
        <div className={row}>
          <dt className="font-semibold text-ds-ink-muted">{t('partner.settings.setup.sanctionsLabel')}</dt>
          <dd className="text-ds-ink">{t('partner.settings.setup.sanctions')}</dd>
        </div>
      </dl>
      <p className="mt-4 text-[13px] text-ds-ink-subtle">{t('partner.settings.setup.changeNote')}</p>
    </Card>
  );
}

export default async function PartnerSettingsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.settings.policy);
  const [partner, margins, payment, enrolled] = await Promise.all([
    getPartnerStore().getPartner(ctx.partnerId),
    marginRows(ctx.partnerId),
    paymentConfig(ctx.partnerId),
    viewerEnrolled(ctx.username, ctx.partnerId),
  ]);
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
  const shown = resolvePartnerDisclosure(partner);

  return (
    <>
      {header}
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <SetupCard view={setupView(partner, payment)} />
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
          <div className="mt-6">
            <ComplianceAlertEmailForm current={sc.complianceAlertEmail ?? ''} />
          </div>
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.settings.disclosure.title')}</h2>
          <p className={INTRO}>{t('partner.settings.disclosure.intro')}</p>
          {sc.disclosure ? (
            <p data-testid="settings-disclosure-approval" data-approved={shown.partnerApproved ? 'true' : 'false'} className="mb-2 text-[14px] font-semibold text-ds-ink">
              {shown.partnerApproved
                ? t('partner.settings.disclosure.approved', { who: sc.disclosure.approval?.by ?? '', date: day(sc.disclosure.approval?.at) })
                : t('partner.settings.disclosure.notApproved')}
            </p>
          ) : null}
          {!enrolled ? (
            <p data-testid="settings-disclosure-enrol" className="mb-4 text-[13px] text-ds-ink-muted">{t('partner.settings.disclosure.enrolToApprove')}</p>
          ) : null}
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
