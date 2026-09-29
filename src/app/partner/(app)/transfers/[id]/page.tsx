import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { loadPartnerTransferDetail } from '@/db/repos/partner-transfer-reads';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_OPS } from '@/lib/partner-access';
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
import { newRequestKey } from '@/lib/portal-request-key';
import { logWarn } from '@/lib/log';
import { t } from '@/lib/i18n';
import { Badge, Card, Money, PageHeader, StatusPill, buttonVariants } from '@/components/ds';
import type { PartnerId } from '@/lib/types';
import { PARTNER_ROUTES } from '../../../routes';
import { NoteForm } from './note-form';

export const metadata: Metadata = {
  title: t('partner.transfers.detailTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : '—');
const MAX_ACTOR_LOOKUPS = 20;

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
    logWarn('partner.transfers.actors', err instanceof Error ? err.name : 'error'); // the error name only (no bound values)
  }
  return out;
}

/**
 * /partner/transfers/[id] (UI redesign M3-5 + H5). The route param is resolved INSIDE the session
 * tenant: a foreign or missing id is notFound(). Masked reads only (never a decrypting read): the
 * destination is `****last4`, phones are `••••last4`, the recipient name is first word + initial,
 * provider and rail references are `****last4`. Hold reasons render only from known labels.
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
  const reasons = holdReasonKeys(transfer.complianceReasons);
  const funding = fundingView(transfer);
  const events = detail.fundingEvents.map(fundingEventView);
  const settlement = settlementView(transfer, detail.rail);
  const test = (transfer.environment ?? 'live') === 'test';
  const currency = transfer.sourceCurrency ?? 'USD';
  const destination = transfer.payoutDestination.startsWith('****') ? transfer.payoutDestination : '****';

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
            <Row label={t('partner.transfers.sender')}>
              <span className="font-mono">{maskPhoneLast4(transfer.phone)}</span>
            </Row>
            <Row label={t('partner.transfers.recipient')}>{maskRecipientName(transfer.recipientName)}</Row>
            <Row label={t('partner.transfers.recipientPhone')}>
              <span className="font-mono">{maskPhoneLast4(transfer.recipientPhone)}</span>
            </Row>
            <Row label={t('partner.transfers.destination')}>
              <span className="font-mono">
                {payoutMethodLabel(transfer.payoutMethod)} {destination}
              </span>
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
        </Card>

        {held ? (
          <Section title={t('partner.transfers.holdTitle')}>
            <p className="text-[14.5px] text-ds-ink-muted">{t('partner.transfers.holdBody')}</p>
            <ul className="mt-2 list-disc pl-5 text-[14.5px] text-ds-ink" data-testid="partner-hold-reasons">
              {reasons.map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] text-ds-ink-muted">{t('partner.transfers.holdRelease')}</p>
          </Section>
        ) : null}

        {canNote ? (
          <Section title={t('partner.transfers.noteTitle')}>
            <NoteForm id={transfer.id} requestKey={newRequestKey()} />
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
