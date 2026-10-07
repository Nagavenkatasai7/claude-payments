import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { loadPartnerTransferDetail } from '@/db/repos/partner-transfer-reads';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_ADMIN, PARTNER_OPS } from '@/lib/partner-access';
import { getPartnerStore } from '@/lib/partner-store';
import { isPartnerReleasableHold } from '@/lib/compliance-config';
import { loadSenderScreening } from '@/lib/sender-screening';
import {
  fundingEventView,
  fundingView,
  holdReasonKeys,
  isHeld,
  maskRecipientName,
  settlementView,
  transferTimeline,
  type TimelineAuditRow,
} from '@/lib/partner-transfers';
import { maskPhoneLast4 } from '@/lib/mask';
import { payoutMethodLabel } from '@/lib/payout-format';
import { purposeView } from '@/lib/purpose-codes';
import { newRequestKey } from '@/lib/portal-request-key';
import { logWarn } from '@/lib/log';
import { t } from '@/lib/i18n';
import { Badge, Card, MaskedValue, Money, PageHeader, StatusPill, buttonVariants } from '@/components/ds';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { revealCapabilities, revealViewer } from '@/lib/partner-reveal-policy';
import { assigneeView, issueRefundEligibility, settlementRouteKey, transferOpsFor, type RevealableTransferField } from '@/lib/partner-transfer-ops';
import { tenantTransferAssignees } from '@/lib/transfer-assignable';
import { hasPermission } from '@/lib/permissions';
import { toStaffOptions } from '@/lib/staff-options';
import { tenantStaffUsernames } from '@/lib/partner-tickets';
import type { PartnerId } from '@/lib/types';
import { PARTNER_ROUTES } from '../../../routes';
import { partnerCustomerHref } from '../../../customer-link';
import { revealTransferFieldAction } from './reveal-actions';
import { AssignForm, CancelControl, ResendForm } from './transfer-ops';
import { IssueRefundDialog } from './issue-refund-dialog';
import { NoteForm } from './note-form';
import { ReleaseDialog } from './release-dialog';
import { RejectDialog } from './reject-dialog';
import { PartnerAmlExplain } from './aml-explain';

// The AML Explain server action waits up to AML_EXPLAIN_TIMEOUT_MS (45 s) for
// the model; a page-level maxDuration sets the limit for this page's actions.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: t('partner.transfers.detailTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : '—');
const MAX_ACTOR_LOOKUPS = 20;
const NAME_MASK = '••••••';
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-[14.5px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-right tabular-nums ${strong ? 'font-bold text-ds-ink' : 'text-ds-ink'}`}>{children}</dd>
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

/** The staff actors on this trail who belong to the SESSION tenant (shown by name); others are masked. */
async function tenantActors(partnerId: PartnerId, audit: TimelineAuditRow[]): Promise<Set<string>> {
  const names = [...new Set(audit.filter((a) => a.actorType === 'staff').map((a) => a.actor))].slice(0, MAX_ACTOR_LOOKUPS);
  const out = new Set<string>();
  try {
    const store = getAuthStore();
    const staff = await Promise.all(names.map((u) => store.getStaff(u)));
    for (const s of staff) if (s && s.partnerId === partnerId) out.add(s.username);
  } catch (err) {
    // Fail closed: an unknown actor is shown as SmartRemit, never by name.
    logWarn('partner.transfers.actors', errName(err)); // the error name only (no bound values)
  }
  return out;
}

/** Enrolled two-step verification; a lookup failure hides every Show control (fail closed). */
async function mfaEnrolled(username: string): Promise<boolean> {
  try {
    return await getStaffMfaStore().isEnrolled(username);
  } catch (err) {
    logWarn('partner.transfers.mfa', errName(err));
    return false;
  }
}

/**
 * /partner/transfers/[id] (UI redesign M3-5 + H5). The route param is resolved INSIDE the session
 * tenant: a foreign or missing id is notFound(). Masked reads only (never a decrypting read): the
 * destination is `****last4`, phones are `••••last4`, the recipient name is first word + initial,
 * provider and rail references are `****last4`. Hold reasons render only from known labels.
 * Lost-features restore p1 B3: the sender name and phone, the recipient name and phone and the
 * payout account each have a click-to-reveal for the viewers the ONE reveal rule allows
 * (partner-reveal-policy; the Show control depends on the viewer only, never on the transfer).
 * Nothing is decrypted on render, so the page writes no audit row; each reveal writes `pii.reveal`.
 * The settling partner is shown by class only, never named.
 */
export default async function PartnerTransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.transfers.policy);
  const { id } = await params;
  const detail = await loadPartnerTransferDetail(getDb(), ctx.partnerId, id);
  if (!detail) notFound();
  const { transfer } = detail;

  const tenant = await tenantActors(ctx.partnerId, detail.audit);
  const timeline = transferTimeline(transfer, detail.audit, tenant);
  const held = isHeld(transfer);
  const canNote = held && PARTNER_OPS.roles.includes(ctx.role);
  // M3-10: the Release button is UX only; releaseHoldAction re-runs the same predicate as the guard.
  // The owner and sender lookups run only for an in_review hold (the only status the predicate can
  // accept). The sender read never throws: a miss or a failure hides the button (fail closed).
  const inReview = transfer.status === 'in_review';
  const [owner, sender] = inReview
    ? await Promise.all([getPartnerStore().getPartner(ctx.partnerId), loadSenderScreening(getDb(), ctx.partnerId, transfer.phone)])
    : [null, null];
  const releasable = isPartnerReleasableHold(transfer, owner, sender);
  const canRelease = releasable && PARTNER_ADMIN.roles.includes(ctx.role);
  const reasons = holdReasonKeys(transfer.complianceReasons);
  const funding = fundingView(transfer);
  const events = detail.fundingEvents.map(fundingEventView);
  const settlement = settlementView(transfer, detail.rail);
  const test = (transfer.environment ?? 'live') === 'test';
  const currency = transfer.sourceCurrency ?? 'USD';
  const destination = transfer.payoutDestination.startsWith('****') ? transfer.payoutDestination : '****';
  // A3: the stated purpose and, where one exists, the UNCONFIRMED suggested RBI code (staff/partner only).
  const purpose = purposeView(transfer.purpose);
  const ops = PARTNER_OPS.roles.includes(ctx.role);
  const caps = ops ? revealCapabilities(revealViewer(ctx, await mfaEnrolled(ctx.username))) : { identity: false, destination: false };
  // An existing customer row in THIS tenant (admin and agent only): the sender-name reveal and the
  // customer link. A sandbox sender has no row, so neither shows.
  const customerHref = await partnerCustomerHref(ctx, transfer.phone);
  const assignee = assigneeView(
    transfer.assignedTo,
    transfer.assignedTo ? await tenantStaffUsernames(ctx.partnerId, [transfer.assignedTo], (u) => getAuthStore().getStaff(u)) : new Set<string>(),
  );
  // Lost-features restore p1: the controls this viewer may use (UX only; each action re-checks).
  const opsFor = transferOpsFor(transfer, ctx);
  const assignOptions = opsFor.assign ? toStaffOptions(tenantTransferAssignees(await getAuthStore().listStaff(), ctx.partnerId)) : [];
  const anyOp = opsFor.assign || opsFor.resend || opsFor.cancel;
  // Issue refund (admin only): offered when eligible; a paid or delivered transfer another network
  // partner pays out says why there is no button (by route class only, never the partner's name).
  const refundRouted =
    ctx.role === 'admin' && (transfer.status === 'paid' || transfer.status === 'delivered') && issueRefundEligibility(transfer, ctx.partnerId) === 'routed';
  // An agent missing a per-staff flag is told why a control is absent (SmartRemit sets the flags).
  const missingFlag = ctx.role === 'agent' && !(['canCancel', 'canAssign', 'canResend'] as const).every((p) => hasPermission(ctx.staff, p));
  const reveal = (field: RevealableTransferField) => revealTransferFieldAction.bind(null, transfer.id, field);
  const shown = (masked: string, field: RevealableTransferField, label: string, allowed: boolean) =>
    allowed ? <MaskedValue masked={masked} label={label} reveal={reveal(field)} /> : <span className="font-mono">{masked}</span>;

  return (
    <>
      <PageHeader
        title={t('partner.transfers.detailTitle')}
        sub={<span className="font-mono">#{transfer.id}</span>}
        actions={
          <Link href="/partner/transfers" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
            {t('partner.transfers.back')}
          </Link>
        }
      />
      <div className="flex flex-col gap-5">
        <Card as="section" className="flex flex-col gap-4 p-5 sm:p-6">
          <h2 className="sr-only">{t('partner.transfers.summary')}</h2>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusPill status={transfer.status} refundStatus={transfer.refundStatus} />
              {held ? (
                <Badge tone="warning">
                  <ShieldAlert aria-hidden="true" className="size-3.5" />
                  {t('partner.transfers.heldBadge')}
                </Badge>
              ) : null}
              {test ? (
                <Badge tone="neutral">
                  <FlaskConical aria-hidden="true" className="size-3.5" />
                  {t('partner.transfers.testBadge')}
                </Badge>
              ) : null}
            </span>
            <span className="text-[13.5px] text-ds-ink-muted">{when(transfer.createdAt)}</span>
          </div>
          <dl className="divide-y divide-ds-border">
            {customerHref ? (
              <Row label={t('partner.transfers.senderName')}>
                {shown(NAME_MASK, 'full_name', t('partner.transfers.senderName'), caps.identity)}
              </Row>
            ) : null}
            <Row label={t('partner.transfers.senderPhone')}>
              <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                {shown(maskPhoneLast4(transfer.phone), 'phone', t('partner.transfers.senderPhone'), caps.identity)}
                {customerHref ? (
                  // prefetch={false}: the customer page writes a pii.view row on render.
                  <Link href={customerHref} prefetch={false} className="text-[13px] font-semibold text-ds-primary hover:underline">
                    {t('partner.transfers.openCustomer')}
                  </Link>
                ) : null}
              </span>
            </Row>
            <Row label={t('partner.transfers.recipientName')}>
              {shown(maskRecipientName(transfer.recipientName), 'recipient_name', t('partner.transfers.recipientName'), caps.identity)}
            </Row>
            <Row label={t('partner.transfers.recipientPhone')}>
              {shown(maskPhoneLast4(transfer.recipientPhone), 'recipient_phone', t('partner.transfers.recipientPhone'), caps.identity && Boolean(transfer.recipientPhone))}
            </Row>
            <Row label={t('partner.transfers.destination')}>
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <span>{payoutMethodLabel(transfer.payoutMethod)}</span>
                {shown(destination, 'payout_destination', t('partner.transfers.destination'), caps.destination && destination !== '****')}
              </span>
            </Row>
            {/* A3: always shown, so "no purpose" reads as "Not stated", not as a missing feature. */}
            <Row label={t('partner.transfers.purpose')}>
              {purpose ? (
                <span className="inline-flex flex-col items-end gap-0.5">
                  <span>{purpose.label}</span>
                  {purpose.suggestedCode ? (
                    <span className="text-[13px] text-ds-ink-muted">
                      {t('partner.transfers.purposeSuggestedCode', { code: purpose.suggestedCode })}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-ds-ink-muted">{t('partner.transfers.purposeNotStated')}</span>
              )}
            </Row>
            <Row label={t('partner.transfers.settledVia')}>{t(settlementRouteKey(transfer, ctx.partnerId))}</Row>
            <Row label={t('partner.transfers.assignedTo')}>
              {assignee.kind === 'tenant'
                ? assignee.username
                : t(assignee.kind === 'smartremit' ? 'partner.transfers.assigneeSmartRemit' : 'partner.transfers.unassigned')}
            </Row>
            <Row label={t('partner.transfers.youSend')}>
              <Money amount={transfer.amountSource ?? transfer.amountUsd} currency={currency} />
            </Row>
            <Row label={t('partner.transfers.fee')}>
              <Money amount={transfer.feeSource ?? transfer.feeUsd} currency={currency} />
            </Row>
            <Row label={t('partner.transfers.total')} strong>
              <Money amount={transfer.totalChargeSource ?? transfer.totalChargeUsd} currency={currency} />
            </Row>
            <Row label={t('partner.transfers.theyGet')} strong>
              <Money amount={transfer.amountInr} currency={transfer.destinationCurrency ?? 'INR'} />
            </Row>
            <Row label={t('partner.transfers.mode')}>{t(test ? 'partner.transfers.env.test' : 'partner.transfers.env.live')}</Row>
          </dl>
          {caps.identity ? <p className="text-[13px] text-ds-ink-muted">{t('partner.transfers.revealNote')}</p> : null}
          {ops && !caps.identity ? <p className="text-[13px] text-ds-ink-muted">{t('partner.transfers.revealMfa')}</p> : null}
          {caps.identity && !caps.destination ? <p className="text-[13px] text-ds-ink-muted">{t('partner.transfers.revealPermission')}</p> : null}
        </Card>

        {held ? (
          <Section title={t('partner.transfers.holdTitle')}>
            <p className="text-[14.5px] text-ds-ink-muted">{t('partner.transfers.holdBody')}</p>
            <ul className="mt-2 list-disc pl-5 text-[14.5px] text-ds-ink" data-testid="partner-hold-reasons">
              {reasons.map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
            {canRelease ? (
              // Merge plan 2c (D4): reject & refund is offered on exactly the holds the partner may
              // release (partnerMayRejectHold is the same rule); the action re-checks both.
              <div className="mt-4 flex flex-wrap items-start gap-3">
                <ReleaseDialog id={transfer.id} />
                <RejectDialog id={transfer.id} />
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-ds-ink-muted">
                {t(releasable ? 'partner.release.adminOnly' : 'partner.transfers.holdRelease')}
              </p>
            )}
            {/* A4 (D5: admins only; the action re-gates): read-only AML explain. */}
            {PARTNER_ADMIN.roles.includes(ctx.role) ? (
              <div className="mt-4">
                <PartnerAmlExplain transferId={transfer.id} />
              </div>
            ) : null}
          </Section>
        ) : null}

        {canNote ? (
          <Section title={t('partner.transfers.noteTitle')}>
            <NoteForm id={transfer.id} requestKey={newRequestKey()} />
          </Section>
        ) : null}

        {ops && (anyOp || missingFlag) ? (
          <Section title={t('partner.transferOps.title')}>
            {anyOp ? (
              <div className="flex flex-col gap-6">
                {opsFor.assign ? <AssignForm id={transfer.id} options={assignOptions} current={assignee.kind === 'tenant' ? assignee.username : null} /> : null}
                {opsFor.resend ? <ResendForm id={transfer.id} /> : null}
                {opsFor.cancel ? <CancelControl id={transfer.id} /> : null}
              </div>
            ) : null}
            {missingFlag ? <p className="mt-3 text-[13px] text-ds-ink-muted">{t('partner.transferOps.askPermission')}</p> : null}
          </Section>
        ) : null}

        {opsFor.refund || refundRouted ? (
          <Section title={t('partner.transferOps.refund.title')}>
            {opsFor.refund ? (
              <IssueRefundDialog id={transfer.id} delivered={transfer.status === 'delivered'} />
            ) : (
              <p className="text-[13px] text-ds-ink-muted">{t('partner.transferOps.refund.routed')}</p>
            )}
          </Section>
        ) : null}

        <Section title={t('partner.transfers.fundingTitle')}>
          <dl className="divide-y divide-ds-border">
            <Row label={t('partner.transfers.fundingMethod')}>{t(funding.method)}</Row>
            {funding.provider ? <Row label={t('partner.transfers.fundingProvider')}>{funding.provider}</Row> : null}
            <Row label={t('partner.transfers.fundingState')}>{funding.state ? t(funding.state) : t('partner.transfers.fundingNoState')}</Row>
            {funding.ref ? (
              <Row label={t('partner.transfers.fundingRef')}>
                <span className="font-mono">{funding.ref}</span>
              </Row>
            ) : null}
          </dl>
          {events.length > 0 ? (
            <>
              <h3 className="mt-4 text-[14.5px] font-semibold text-ds-ink">{t('partner.transfers.fundingEvents')}</h3>
              <ul className="mt-2 flex flex-col gap-2 text-[14px]">
                {events.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-ds-ink">
                      {t(e.type)} · {t(e.outcome)}
                      {e.ref ? <span className="ml-2 font-mono text-[12.5px] text-ds-ink-muted">{e.ref}</span> : null}
                    </span>
                    <span className="text-[13px] text-ds-ink-muted">{when(e.at)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>

        <Section title={t('partner.transfers.settlementTitle')}>
          <dl className="divide-y divide-ds-border">
            <Row label={t('partner.transfers.settlementState')}>{t(settlement.state)}</Row>
            {settlement.ref ? (
              <Row label={t('partner.transfers.settlementRef')}>
                <span className="font-mono">{settlement.ref}</span>
              </Row>
            ) : null}
            {settlement.attempts ? <Row label={t('partner.transfers.settlementAttempts')}>{settlement.attempts}</Row> : null}
          </dl>
        </Section>

        <Section title={t('partner.transfers.timelineTitle')}>
          <ol className="flex flex-col gap-3" data-testid="partner-transfer-timeline">
            {timeline.map((r, i) => (
              <li key={`${r.kind}-${i}`} className="border-l-2 border-ds-border pl-3">
                <span className="block text-[14.5px] font-semibold text-ds-ink">
                  {t(r.label)}
                  {r.by ? <span className="font-normal text-ds-ink-muted"> {t('partner.transfers.timeline.by', { who: r.by })}</span> : null}
                </span>
                <span className="block text-[13px] text-ds-ink-muted">{when(r.at)}</span>
                {r.note ? <p className="mt-1 whitespace-pre-wrap break-words text-[14px] text-ds-ink">{r.note}</p> : null}
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </>
  );
}
