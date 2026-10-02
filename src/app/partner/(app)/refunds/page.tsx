import type { Metadata } from 'next';
import Link from 'next/link';
import { FlaskConical, RotateCcw } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { listPartnerRefunds } from '@/db/repos/partner-transfer-reads';
import { refundCounts, toPartnerRefundRow, type PartnerRefundRow, type RefundCounts } from '@/lib/partner-refunds';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, EmptyState, Money, PageHeader } from '@/components/ds';
import type { Tone } from '@/lib/ui/transfer-status';
import type { RefundStatus } from '@/lib/types';
import { PARTNER_ROUTES } from '../../routes';
import { RefundControls } from './refund-controls';

export const metadata: Metadata = {
  title: t('partner.refunds.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// /partner/refunds (merge plan 2b): every refund on the SESSION tenant's transfers, in any state.
// Masked rows only (the default ledger read): the sender as its last 4 digits, the recipient as
// first word + initial; no decrypted name. Every role on the money-read policy may view; the
// approve / dismiss / retry dialogs render for admins only (D1), and the server action re-gates
// (approve and retry behind a fresh step-up, D2).

const LIST_CAP = 200; // transfer-repo listActiveRefunds' default limit
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : '—');
const FOCUS = 'rounded-ds-focus focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TONE: Record<RefundStatus, Tone> = { requested: 'warning', pending: 'info', failed: 'danger', completed: 'success', none: 'neutral' };
const COUNT_ORDER: Array<keyof RefundCounts> = ['requested', 'pending', 'failed', 'completed'];

function RefundBadge({ status }: { status: RefundStatus }) {
  return <Badge tone={TONE[status] ?? 'neutral'}>{t(`partner.refunds.status.${status}` as MessageKey)}</Badge>;
}

function TestBadge() {
  return (
    <Badge tone="neutral">
      <FlaskConical aria-hidden="true" className="size-3.5" />
      {t('partner.transfers.testBadge')}
    </Badge>
  );
}

function Actions({ r, isAdmin }: { r: PartnerRefundRow; isAdmin: boolean }) {
  if (r.controls.approve || r.controls.dismiss || r.controls.retry) return <RefundControls id={r.id} controls={r.controls} />;
  if (!isAdmin && (r.refundStatus === 'requested' || r.refundStatus === 'failed')) {
    return <span className="text-[13px] text-ds-ink-muted">{t('partner.refunds.adminOnly')}</span>;
  }
  return <span className="text-ds-ink-muted">—</span>;
}

function TransferLink({ id }: { id: string }) {
  return (
    <Link href={`/partner/transfers/${id}`} className={`font-mono text-[13px] font-semibold text-ds-primary hover:underline ${FOCUS}`}>
      {id}
    </Link>
  );
}

export default async function PartnerRefundsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.refunds.policy);
  const list = await listPartnerRefunds(getDb(), ctx.partnerId);
  const counts = refundCounts(list);
  const rows = list.map((tr) => toPartnerRefundRow(tr, ctx.role));
  const isAdmin = ctx.role === 'admin';

  return (
    <>
      <PageHeader title={t('partner.refunds.title')} sub={t('partner.refunds.sub')} />
      <div className="flex flex-col gap-5">
        <dl aria-label={t('partner.refunds.countsLabel')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {COUNT_ORDER.map((k) => (
            <div key={k} className="rounded-ds-inner border border-ds-border bg-ds-surface p-4">
              <dt className="text-[13px] font-semibold text-ds-ink-muted">{t(`partner.refunds.count.${k}` as MessageKey)}</dt>
              <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink tabular-nums" data-count={k}>
                {counts[k]}
              </dd>
            </div>
          ))}
        </dl>

        {list.length >= LIST_CAP ? <p className="text-[14px] text-ds-ink-muted">{t('partner.refunds.truncated', { count: LIST_CAP })}</p> : null}

        {rows.length === 0 ? (
          <div data-empty>
            <EmptyState icon={<RotateCcw className="size-5" />} title={t('partner.refunds.emptyTitle')} body={t('partner.refunds.emptyBody')} />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface lg:block">
              <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
                <caption className="sr-only">{t('partner.refunds.caption')}</caption>
                <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.transfer')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.sender')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.recipient')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.amount')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.status')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.date')}</th>
                    <th scope="col" className="px-4 py-3 font-semibold">{t('partner.refunds.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-ds-border align-top" data-row={r.id}>
                      <td className="px-4 py-3">
                        <TransferLink id={r.id} />
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px]">{r.sender}</td>
                      <td className="px-4 py-3 font-semibold">{r.recipient}</td>
                      <td className="px-4 py-3">
                        <Money amount={r.amount} currency={r.currency} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <RefundBadge status={r.refundStatus} />
                          {r.test ? <TestBadge /> : null}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ds-ink-muted">{when(r.at)}</td>
                      <td className="px-4 py-3">
                        <Actions r={r} isAdmin={isAdmin} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul data-cards className="flex flex-col gap-3 lg:hidden" aria-label={t('partner.refunds.caption')}>
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4">
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ds-ink">{r.recipient}</span>
                      <span className="block truncate font-mono text-[12.5px] text-ds-ink-muted">{r.sender}</span>
                    </span>
                    <span className="shrink-0 font-semibold text-ds-ink">
                      <Money amount={r.amount} currency={r.currency} />
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <RefundBadge status={r.refundStatus} />
                      {r.test ? <TestBadge /> : null}
                    </span>
                    <span className="text-[13px] text-ds-ink-muted">{when(r.at)}</span>
                  </span>
                  <TransferLink id={r.id} />
                  <Actions r={r} isAdmin={isAdmin} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
