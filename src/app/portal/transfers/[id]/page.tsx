import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, Circle, CircleDot, OctagonAlert } from 'lucide-react';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { verifiedReceiptEmail } from '@/lib/portal-prefs';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalTransfer, portalOwner, transferTimeline, type TimelineState } from '@/lib/portal-transfers';
import { refundDisposition } from '@/lib/refund-policy';
import { payoutMethodLabel } from '@/lib/payout-format';
import { newRequestKey } from '@/lib/portal-request-key';
import { RECALL_REASON_VALUES } from '@/lib/receipt-cores';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Card, Money, PageHeader, StatusPill } from '@/components/ds';
import { cancelTransferPortalAction, emailReceiptAction, requestRecallPortalAction, requestRefundPortalAction } from './actions';
import { ActionForm, RecallForm } from './transfer-actions';
import { portalMetadata } from '@/lib/portal-metadata';
import { sendAgainAction } from '../../send/actions';
import { SendAgainForm } from '../../send/send-again-form';

export const generateMetadata = () => portalMetadata('portal.detail.title', { referrer: 'no-referrer' });

const RECALL_LABEL: Record<(typeof RECALL_REASON_VALUES)[number], MessageKey> = {
  not_received: 'portal.recall.reason.not_received',
  wrong_recipient: 'portal.recall.reason.wrong_recipient',
  wrong_amount: 'portal.recall.reason.wrong_amount',
  unauthorized: 'portal.recall.reason.unauthorized',
  other: 'portal.recall.reason.other',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : undefined);
const CANCEL_UNTIL = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

const STEP_ICON: Record<TimelineState, ReactNode> = {
  done: <Check aria-hidden="true" className="size-4 text-ds-success-ink" />,
  current: <CircleDot aria-hidden="true" className="size-4 text-ds-primary" />,
  upcoming: <Circle aria-hidden="true" className="size-4 text-ds-ink-faint" />,
  stopped: <OctagonAlert aria-hidden="true" className="size-4 text-ds-warning-ink" />,
};
const STEP_STATE: Record<TimelineState, MessageKey> = {
  done: 'portal.timeline.state.done',
  current: 'portal.timeline.state.current',
  upcoming: 'portal.timeline.state.upcoming',
  stopped: 'portal.timeline.state.stopped',
};

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-[14.5px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-right tabular-nums ${strong ? 'font-bold text-ds-ink' : 'text-ds-ink'}`}>{children}</dd>
    </div>
  );
}

/**
 * One transfer (UI redesign M2-7, Task 7.2). Scoped to the host partner AND the session phone:
 * another customer's or another partner's transfer is a 404 (the same as a missing one). The
 * destination is the ledger's masked read only. The actions follow refundDisposition (a hint: each
 * server action re-checks everything).
 */
export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const { id } = await params;
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, id);
  if (!transfer) notFound();
  // "Email me a receipt" only for an address verified on THIS partner (the action re-checks it).
  const canEmail = (await verifiedReceiptEmail(getDb(), { partnerId: owner.partnerId, senderPhone: owner.phone, email: ctx.customer.email })) !== null;

  const now = Date.now();
  const disp = refundDisposition(transfer, now);
  const steps = transferTimeline(transfer);
  const currency = transfer.sourceCurrency ?? 'USD';
  const destCurrency = transfer.destinationCurrency ?? 'INR';
  const key = () => newRequestKey();

  return (
    <>
      <PageHeader
        title={t('portal.detail.title')}
        sub={<span className="font-mono">#{transfer.id}</span>}
        actions={
          <Button asChild variant="ghost" size="md">
            <Link href="/portal/transfers">{t('portal.detail.back')}</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusPill status={transfer.status} refundStatus={transfer.refundStatus} />
            <span className="text-[13.5px] text-ds-ink-muted">{when(transfer.createdAt)}</span>
          </div>
          <dl className="divide-y divide-ds-border">
            <Row label={t('portal.receipt.recipient')}>{transfer.recipientName}</Row>
            <Row label={t('portal.receipt.destination')}>
              <span className="font-mono">
                {payoutMethodLabel(transfer.payoutMethod)} {transfer.payoutDestination}
              </span>
            </Row>
            <Row label={t('portal.receipt.youSend')}>
              <Money amount={transfer.amountSource ?? transfer.amountUsd} currency={currency} />
            </Row>
            <Row label={t('portal.receipt.fee')}>
              <Money amount={transfer.feeSource ?? transfer.feeUsd} currency={currency} />
            </Row>
            <Row label={t('portal.receipt.total')} strong>
              <Money amount={transfer.totalChargeSource ?? transfer.totalChargeUsd} currency={currency} />
            </Row>
            <Row label={t('portal.receipt.theyGet')} strong>
              <Money amount={transfer.amountInr} currency={destCurrency} />
            </Row>
          </dl>
        </Card>

        <Card as="section" className="p-5 sm:p-6">
          <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.detail.progress')}</h2>
          <ol className="mt-4 flex flex-col gap-3">
            {steps.map((s) => (
              <li key={s.key} className="flex items-start gap-3">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-ds-ground ring-1 ring-ds-border">{STEP_ICON[s.state]}</span>
                <span className="min-w-0">
                  <span className={`block text-[14.5px] ${s.state === 'upcoming' ? 'text-ds-ink-muted' : 'font-semibold text-ds-ink'}`}>{t(s.key)}</span>
                  <span className="sr-only">{t(STEP_STATE[s.state])}</span>
                  {s.at ? <span className="block text-[13px] text-ds-ink-muted">{when(s.at)}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        {disp.kind === 'cancellable' || disp.kind === 'refundable' || disp.kind === 'recall_eligible' ? (
          <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
            {disp.kind === 'cancellable' ? (
              <>
                <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.detail.cancelTitle')}</h2>
                <p className="text-[14px] text-ds-ink-muted">
                  {t('portal.detail.cancelBody', { until: CANCEL_UNTIL.format(new Date(now + disp.msLeft)) })}
                </p>
                <ActionForm
                  action={cancelTransferPortalAction.bind(null, transfer.id)}
                  requestKey={key()}
                  label={t('portal.detail.cancelCta')}
                  busyLabel={t('portal.detail.working')}
                  variant="danger"
                />
              </>
            ) : null}
            {disp.kind === 'refundable' ? (
              <>
                <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.detail.refundTitle')}</h2>
                <p className="text-[14px] text-ds-ink-muted">{t('portal.detail.refundBody')}</p>
                <ActionForm
                  action={requestRefundPortalAction.bind(null, transfer.id)}
                  requestKey={key()}
                  label={t('portal.detail.refundCta')}
                  busyLabel={t('portal.detail.working')}
                />
              </>
            ) : null}
            {disp.kind === 'recall_eligible' ? (
              <>
                <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.detail.recallTitle')}</h2>
                <p className="text-[14px] text-ds-ink-muted">{t('portal.detail.recallBody')}</p>
                <RecallForm
                  action={requestRecallPortalAction.bind(null, transfer.id)}
                  requestKey={key()}
                  reasons={RECALL_REASON_VALUES.map((value) => ({ value, label: RECALL_LABEL[value] }))}
                />
              </>
            ) : null}
            <p className="text-[13px] text-ds-ink-muted">{t('portal.detail.stepUpNote')}</p>
          </Card>
        ) : null}

        {transfer.status !== 'blocked' && transfer.transferType !== 'b2b' ? (
          <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
            <h2 data-send-again className="text-[17px] font-bold text-ds-ink">{t('portal.send.sendAgainTitle')}</h2>
            <p className="text-[14px] text-ds-ink-muted">{t('portal.send.sendAgainBody')}</p>
            <SendAgainForm action={sendAgainAction.bind(null, transfer.id)} requestKey={key()} />
          </Card>
        ) : null}

        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.detail.receiptTitle')}</h2>
          <p>
            <Link href={`/portal/transfers/${transfer.id}/receipt`} className="text-[14.5px] font-semibold text-ds-primary hover:underline">
              {t('portal.detail.receiptLink')}
            </Link>
          </p>
          {canEmail ? (
            <ActionForm
              action={emailReceiptAction.bind(null, transfer.id)}
              requestKey={key()}
              label={t('portal.detail.emailCta')}
              busyLabel={t('portal.detail.working')}
            />
          ) : (
            <p className="text-[14px] text-ds-ink-muted">
              {t('portal.detail.emailNeedsVerify')}{' '}
              <Link href="/portal/notifications" className="font-semibold text-ds-primary hover:underline">
                {t('portal.detail.emailNeedsVerifyLink')}
              </Link>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
