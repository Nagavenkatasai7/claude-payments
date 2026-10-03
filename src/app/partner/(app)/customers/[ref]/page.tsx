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
import { auditIdentityView, auditSubjectId, openCustomerRef } from '@/lib/customer-ref';
import { getAuthStore } from '@/lib/auth-store';
import { listTenantAuditForSubject } from '@/db/repos/tenant-audit-repo';
import { listTenantStaff } from '@/lib/partner-staff-policy';
import { scopeOf } from '@/lib/staff-scope';
import { KYC_TRAIL_ACTIONS, partnerKycTrail } from '@/lib/partner-kyc-trail';
import { revealCapabilities, revealViewer } from '@/lib/partner-reveal-policy';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { customerDetailView, customerProfileView, sendingTodayView } from '@/lib/partner-customer-view';
import { evaluateCap } from '@/lib/tier-rules';
import { listPartnerCustomerTransfers } from '@/db/repos/partner-customer-reads';
import { decodeTransferCursor, encodeTransferCursor } from '@/lib/partner-transfers';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { PLATFORM_SEND_LIMITS, resolveEffectiveSendLimits, type SendLimitSource } from '@/lib/send-limits';
import { partnerMayWriteOverride } from '@/lib/partner-send-limits';
import { partnerKycOfferedDecisions } from '@/lib/partner-reviews';
import { formatMoney } from '@/lib/ui/money';
import { t, type MessageKey } from '@/lib/i18n';
import { Card, MaskedValue, PageHeader, buttonVariants } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { revealCustomerFieldAction } from './actions';
import { LimitForm } from './limit-form';
import { KycDecisionDialog } from './kyc-decision-dialog';
import { CustomerTransfers, toCustomerTransferRow } from './customer-transfers';

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

const SOURCE_KEY: Record<SendLimitSource, MessageKey> = {
  customer: 'partner.limits.source.customer',
  partner: 'partner.limits.source.partner',
  platform: 'partner.limits.source.platform',
};
const usd = (cents: number) => formatMoney(cents / 100);
/** Lost-features p2 A9: the most decision rows the history reads. */
const KYC_TRAIL_LIMIT = 50;
/** Lost-features p2 A10: transfers shown per page on the customer page (keyset "Older" link). */
const CUSTOMER_TRANSFERS_PAGE = 25;

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
export default async function PartnerCustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customers.policy);
  const { ref } = await params;
  const sp = (await searchParams) ?? {};
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) notFound();
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) notFound();
  // Lost-features p2 B6: the profile rows (masked ID, declared PEP, source of funds, occupation) are
  // named in the same pii.view row, only those that render.
  const profile = customerProfileView(customer);
  const alsoShown = [
    ...(profile.govId ? ['gov_id_last4'] : []),
    ...(profile.pepDeclaredKey ? ['pep_declared'] : []),
    ...(profile.sourceOfFundsKey ? ['source_of_funds'] : []),
    ...(profile.occupationKey ? ['occupation'] : []),
  ];
  await auditIdentityView(getDb(), { username: ctx.username }, customer, { actorScope: 'partner', alsoShown });

  const partner = await getPartnerStore().getPartner(ctx.partnerId);
  const view = customerDetailView(customer, ref, new Date(), sendGateActive(partner));
  // The one reveal rule (partner-reveal-policy; lost-features p2 B5): identity fields for admin and
  // agent with two-step verification, no canRevealPii. Mirrors the action (the authority): no Show
  // control that would always be refused. It depends only on the viewer, never on the customer.
  const mfaEnrolled = await getStaffMfaStore().isEnrolled(ctx.username);
  const canReveal = revealCapabilities(revealViewer(ctx, mfaEnrolled)).identity;
  // M3-12: the EFFECTIVE limits (the same resolver a mint uses, partner-set entries re-clamped at
  // read). The form is offered to admins only (the action re-gates PARTNER_ADMIN) and never over a
  // live SmartRemit override (the action refuses that too, under the row lock).
  const now = new Date();
  const limits = resolveEffectiveSendLimits(partner, customer, now);
  // Lost-features p2 B7 and A10: today's spend against the cap (the same ledger read and evaluation
  // a mint uses, figures only) and this customer's live transfers at THIS tenant (masked rows).
  const txCursor = decodeTransferCursor(Array.isArray(sp.tx) ? sp.tx[0] : sp.tx);
  // senderTotals is the daily-volume store's ledger read (ET day; blocked and cancelled excluded).
  // Lost-features p2 A9: the KYC decision history from this tenant's durable audit rows only
  // (partner-kyc-trail decides whose reason may show; SmartRemit's decisions show the outcome only).
  const [totals, txPage, trailRows, allStaff] = await Promise.all([
    getStore().senderTotals(ctx.partnerId, customer.senderPhone),
    listPartnerCustomerTransfers(getDb(), ctx.partnerId, customer.senderPhone, { limit: CUSTOMER_TRANSFERS_PAGE, cursor: txCursor }),
    listTenantAuditForSubject(getDb(), ctx.partnerId, auditSubjectId(ctx.partnerId, customer.senderPhone), KYC_TRAIL_ACTIONS, KYC_TRAIL_LIMIT),
    getAuthStore().listStaff(),
  ]);
  const tenantUsernames = new Set(listTenantStaff(scopeOf(ctx.staff), ctx.partnerId, allStaff).map((m) => m.username));
  const trail = partnerKycTrail(trailRows, tenantUsernames, customer.kycSubmittedAt);
  const today = sendingTodayView(evaluateCap(customer, now, totals.todayUsdCents, 0, sendGateActive(partner), limits));
  const olderHref = txPage.nextCursor ? `${PARTNER_ROUTES.customers.href}/${ref}?tx=${encodeTransferCursor(txPage.nextCursor)}` : null;
  const setBySmartRemit = !partnerMayWriteOverride(customer.sendLimitOverride, now);
  const canEditLimits = PARTNER_ADMIN.roles.includes(ctx.role);
  // Merge plan 2c (D3): the KYC decision is offered to admins only, by KYC mode and the no-op rules
  // (partnerKycOfferedDecisions never reads the screening flags, so the controls are the same with
  // or without a hit). decideKycAction re-checks everything. When nothing is offered ('ours' mode or
  // a no-op) the admin sees ONE neutral line.
  const kycDecisions = canEditLimits ? partnerKycOfferedDecisions(partner, customer) : [];
  const override = customer.sendLimitOverride;
  const partnerSetExpiry =
    !setBySmartRemit && override?.setScope === 'partner' && typeof override.expiresAt === 'string' ? override.expiresAt : null;

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
          {canReveal ? (
            <p className="mt-3 text-[13px] text-ds-ink-muted">{t('partner.customers.revealNote')}</p>
          ) : !mfaEnrolled ? (
            <p className="mt-3 text-[13px] text-ds-ink-muted" data-reveal-hint="">
              {t('partner.customers.revealEnrolHint')}{' '}
              <Link href={PARTNER_ROUTES.security.href} className="font-semibold text-ds-primary underline-offset-4 hover:underline">
                {t('partner.customers.revealEnrolLink')}
              </Link>
            </p>
          ) : null}
        </Section>
        <Section title={t('partner.customers.verification')}>
          <dl className="divide-y divide-ds-border">
            <Row label={t('partner.customers.kycStatus')}>{t(view.kycStatusKey)}</Row>
            <Row label={t('partner.customers.reviewState')}>{t(view.reviewKey)}</Row>
            <Row label={t('partner.customers.tier')}>{t(view.tierKey)}</Row>
            <Row label={t('partner.customers.verifiedAt')}>{when(view.kycVerifiedAt)}</Row>
            <Row label={t('partner.customers.firstSeen')}>{when(view.firstSeenAt)}</Row>
          </dl>
          <div className="mt-4 border-t border-ds-border pt-4" data-testid="partner-kyc-trail">
            <h3 className="mb-2 text-[15px] font-bold text-ds-ink">{t('partner.customers.trail.title')}</h3>
            {trail.length === 0 ? (
              <p className="text-[14px] text-ds-ink-muted">{t('partner.customers.trail.empty')}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {trail.map((e, i) => (
                  <li key={i} className="text-[14px] text-ds-ink" data-trail={e.labelKey.slice('partner.customers.trail.'.length)}>
                    <span className="font-semibold">{t(e.labelKey)}</span>
                    {e.actor ? <span className="text-ds-ink-muted"> · {e.actor}</span> : null}
                    <span className="text-ds-ink-muted"> · {when(e.at)}</span>
                    {e.reason ? (
                      <span className="block break-words text-[13px] text-ds-ink-muted">{t('partner.customers.trail.reason', { reason: e.reason })}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-[12.5px] text-ds-ink-subtle">{t('partner.customers.trail.note')}</p>
          </div>
          {canEditLimits ? (
            <div className="mt-4 border-t border-ds-border pt-4" data-testid="partner-kyc-decision">
              <h3 className="mb-2 text-[15px] font-bold text-ds-ink">{t('partner.kyc.decisionTitle')}</h3>
              {kycDecisions.length > 0 ? (
                <>
                  <p className="mb-3 text-[13px] text-ds-ink-muted">{t('partner.kyc.decisionSub')}</p>
                  <KycDecisionDialog customerRef={view.ref} decisions={kycDecisions} />
                </>
              ) : (
                <p role="note" className="text-[14px] text-ds-ink-muted">
                  {t('partner.reviews.neutral')}
                </p>
              )}
            </div>
          ) : null}
        </Section>
        <Section title={t('partner.customers.profile')}>
          <dl className="divide-y divide-ds-border" data-testid="partner-customer-profile">
            <Row label={t('partner.customers.field.country')}>{profile.country ?? '—'}</Row>
            {profile.govId ? (
              <Row label={t('partner.customers.field.govId')}>
                {t(profile.govId.typeKey)} <span className="font-mono tabular-nums">{profile.govId.last4}</span>
              </Row>
            ) : null}
            {profile.pepDeclaredKey ? (
              <Row label={t('partner.customers.field.pepDeclared')}>{t(profile.pepDeclaredKey)}</Row>
            ) : null}
            {profile.sourceOfFundsKey ? (
              <Row label={t('partner.customers.field.sourceOfFunds')}>{t(profile.sourceOfFundsKey)}</Row>
            ) : null}
            {profile.occupationKey ? (
              <Row label={t('partner.customers.field.occupation')}>{t(profile.occupationKey)}</Row>
            ) : null}
            {profile.verificationRefs.map((r) => (
              <Row key={r} label={t('partner.customers.field.verificationRef')}>
                <span className="font-mono tabular-nums">{r}</span>
              </Row>
            ))}
          </dl>
          <p className="mt-3 text-[13px] text-ds-ink-muted">{t('partner.customers.profileNote')}</p>
        </Section>
      </div>
      <div className="mt-5">
        <Section title={t('partner.limits.title')}>
          <p className="text-[13px] text-ds-ink-muted">{t('partner.limits.sub')}</p>
          <dl className="mt-2 divide-y divide-ds-border" data-testid="partner-sending-today">
            <Row label={t('partner.limits.usedToday')}>
              <span className="tabular-nums" data-today="used">{usd(today.usedCents)}</span>
            </Row>
            <Row label={t('partner.limits.leftToday')}>
              <span className="tabular-nums" data-today="left">{usd(today.remainingCents)}</span>
              <span className="ml-2 text-[13px] text-ds-ink-muted">{t('partner.limits.ofCap', { cap: usd(today.dailyCapCents) })}</span>
            </Row>
            {today.dayOfWindow !== null ? (
              <Row label={t('partner.limits.window')}>
                <span data-today="day">{t('partner.limits.dayOfWindow', { day: today.dayOfWindow })}</span>
              </Row>
            ) : null}
          </dl>
          <dl className="mt-2 divide-y divide-ds-border border-t border-ds-border">
            <Row label={t('partner.limits.perTransfer')}>
              <span className="tabular-nums">{usd(limits.perTransferCapCents)}</span>
              <span className="ml-2 text-[13px] text-ds-ink-muted">{t(SOURCE_KEY[limits.source.perTransferCapCents])}</span>
            </Row>
            <Row label={t('partner.limits.daily')}>
              <span className="tabular-nums">{usd(limits.t1DailyCapCents)}</span>
              <span className="ml-2 text-[13px] text-ds-ink-muted">{t(SOURCE_KEY[limits.source.t1DailyCapCents])}</span>
            </Row>
            <Row label={t('partner.limits.firstDays')}>
              <span className="tabular-nums">{usd(limits.t0DailyCapCents)}</span>
              <span className="ml-2 text-[13px] text-ds-ink-muted">{t(SOURCE_KEY[limits.source.t0DailyCapCents])}</span>
            </Row>
          </dl>
          {partnerSetExpiry ? (
            <p className="mt-2 text-[13px] text-ds-ink-muted">{t('partner.limits.endsOn', { date: when(partnerSetExpiry) })}</p>
          ) : null}
          {canEditLimits ? (
            setBySmartRemit ? (
              <p role="note" className="mt-4 text-[14px] font-semibold text-ds-ink">
                {t('partner.limits.setBySmartRemit')}
              </p>
            ) : (
              <div className="mt-5 border-t border-ds-border pt-5">
                <h3 className="mb-3 text-[15px] font-bold text-ds-ink">{t('partner.limits.formTitle')}</h3>
                <LimitForm customerRef={view.ref} capLabel={usd(PLATFORM_SEND_LIMITS.perTransferCapCents)} />
              </div>
            )
          ) : null}
        </Section>
      </div>
      <div className="mt-5">
        <Section title={t('partner.customers.transfers.title')}>
          <p className="mb-2 text-[13px] text-ds-ink-muted">{t('partner.customers.transfers.sub')}</p>
          <CustomerTransfers rows={txPage.items.map(toCustomerTransferRow)} olderHref={olderHref} />
        </Section>
      </div>
    </>
  );
}
