import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { auditIdentityView, openCustomerRef } from '@/lib/customer-ref';
import { hasPermission } from '@/lib/permissions';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { customerDetailView } from '@/lib/partner-customer-view';
import { t } from '@/lib/i18n';
import { Card, MaskedValue, PageHeader, buttonVariants } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { revealCustomerFieldAction } from './actions';

export const metadata: Metadata = {
  title: t('partner.customers.detailTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const when = (iso?: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? WHEN.format(new Date(iso)) : '—');

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-[14.5px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-ds-ink">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className="text-[17px] font-bold text-ds-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

/**
 * /partner/customers/[ref] (UI redesign M3-11). The ref is an opaque sealed (tenant, phone): a ref
 * that does not open, or names another tenant, is notFound(). The row is then read with the SESSION
 * tenant in the WHERE (the same phone at another partner is a different customer). Before anything
 * renders, ONE `pii.view` row is written (field names only, partner-marked): awaited and not
 * caught, so no record means no page. Everything shown comes from customerDetailView: masked values
 * and closed labels only. No screening detail, rejection reason or ID number is shown. A value is
 * revealed only through the audited action; the client receives the masked string, never the value.
 */
export default async function PartnerCustomerDetailPage({ params }: { params: Promise<{ ref: string }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customers.policy);
  const { ref } = await params;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) notFound();
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) notFound();
  await auditIdentityView(getDb(), { username: ctx.username }, customer, { actorScope: 'partner' });

  const partner = await getPartnerStore().getPartner(ctx.partnerId);
  const view = customerDetailView(customer, ref, new Date(), sendGateActive(partner));
  // Mirrors the action's viewer checks (the action is the authority): no Show control that would
  // always be refused. It depends only on the viewer, never on the customer (no oracle).
  const canReveal = hasPermission(ctx.staff, 'canRevealPii') && (await getStaffMfaStore().isEnrolled(ctx.username));

  return (
    <>
      <PageHeader
        title={t('partner.customers.detailTitle')}
        sub={t('partner.customers.detailSub')}
        actions={
          <Link href={PARTNER_ROUTES.customers.href} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
            {t('partner.customers.back')}
          </Link>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={t('partner.customers.identity')}>
          <dl className="divide-y divide-ds-border">
            {view.fields.map((f) => (
              <Row key={f.field} label={t(f.labelKey)}>
                {canReveal && f.present ? (
                  <MaskedValue
                    masked={f.masked}
                    label={t(f.labelKey)}
                    reveal={revealCustomerFieldAction.bind(null, view.ref, f.field)}
                  />
                ) : (
                  <span className="font-mono tabular-nums">{f.masked}</span>
                )}
              </Row>
            ))}
          </dl>
          {canReveal ? <p className="mt-3 text-[13px] text-ds-ink-muted">{t('partner.customers.revealNote')}</p> : null}
        </Section>
        <Section title={t('partner.customers.verification')}>
          <dl className="divide-y divide-ds-border">
            <Row label={t('partner.customers.kycStatus')}>{t(view.kycStatusKey)}</Row>
            <Row label={t('partner.customers.reviewState')}>{t(view.reviewKey)}</Row>
            <Row label={t('partner.customers.tier')}>{t(view.tierKey)}</Row>
            <Row label={t('partner.customers.verifiedAt')}>{when(view.kycVerifiedAt)}</Row>
            <Row label={t('partner.customers.firstSeen')}>{when(view.firstSeenAt)}</Row>
          </dl>
        </Section>
      </div>
    </>
  );
}
