import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalB2bParties, getPortalTransfer, portalOwner, receiptView } from '@/lib/portal-transfers';
import { payoutMethodLabel } from '@/lib/payout-format';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { buildReceiptDisclosure } from '@/lib/remittance-disclosure';
import { t } from '@/lib/i18n';
import { Money, PageHeader } from '@/components/ds';
import { ReceiptDisclosureCard } from '@/app/account/receipt/[transferId]/disclosure-card';
import { portalMetadata } from '@/lib/portal-metadata';
import { getDb } from '@/db/client';
import { transferRewardOrNull } from '@/lib/rewards/read';
import { EntityBadge, fromLabel, fundingLabel } from '../b2b-parties';

export const generateMetadata = () => portalMetadata('portal.receipt.title', { referrer: 'no-referrer' });

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : undefined);

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-[14.5px] print:py-1">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-right tabular-nums ${strong ? 'font-bold text-ds-ink' : 'text-ds-ink'}`}>{children}</dd>
    </div>
  );
}

/**
 * The printable receipt (UI redesign M2-7, Task 7.2). No script: the browser's own print command
 * prints it, and `print:` variants drop the portal chrome. Masked destination only. The Reg E
 * disclosure block is the legacy receipt's own component (imported, not copied), built for the
 * OWNING partner exactly as /account/receipt builds it.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const site = await requirePortalSite();
  const { id } = await params;
  const ctx = await requirePortalCustomer(`/portal/transfers/${id}/receipt`);
  const owner = portalOwner(ctx);
  const transfer = await getPortalTransfer(owner, id);
  if (!transfer) notFound();
  const v = receiptView(transfer, await transferRewardOrNull(getDb(), owner.partnerId, transfer.id));
  const parties = await getPortalB2bParties(owner, transfer);

  const disclosure = buildReceiptDisclosure(
    {
      transferType: transfer.transferType,
      status: transfer.status,
      amountSource: transfer.amountSource ?? transfer.amountUsd,
      feeSource: transfer.feeSource ?? transfer.feeUsd,
      totalChargeSource: transfer.totalChargeSource ?? transfer.totalChargeUsd,
      sourceCurrency: v.currency,
      amountInr: transfer.amountInr,
      destinationCurrency: v.destCurrency,
      fxRate: transfer.fxRate,
      paidAt: transfer.paidAt,
      deliveredAt: transfer.deliveredAt,
    },
    resolvePartnerDisclosure(await getPartnerStore().getPartner(transfer.partnerId)),
    Date.now(),
  );

  return (
    <>
      <PageHeader
        title={t('portal.receipt.title')}
        sub={t('portal.receipt.sub', { brand: site.brand })}
        actions={
          <Link href={`/portal/transfers/${transfer.id}`} className="text-[14px] font-semibold text-ds-primary hover:underline print:hidden">
            {t('portal.detail.back')}
          </Link>
        }
      />
      <p className="mb-4 text-[13.5px] text-ds-ink-muted print:hidden">{t('portal.receipt.printHint')}</p>
      <div className="grid gap-4 sm:grid-cols-2 print:block">
        <section className="rounded-ds-card border border-ds-border bg-ds-surface p-5 sm:col-span-2 sm:p-6 print:border-0 print:p-0">
          <dl className="divide-y divide-ds-border">
            <Row label={t('portal.receipt.transferId')}>
              <span className="font-mono">{v.id}</span>
            </Row>
            <Row label={t('portal.receipt.date')}>{when(v.createdAt) ?? '—'}</Row>
            {when(transfer.paidAt) ? <Row label={t('portal.receipt.paidAt')}>{when(transfer.paidAt)}</Row> : null}
            {when(transfer.deliveredAt) ? <Row label={t('portal.receipt.deliveredAt')}>{when(transfer.deliveredAt)}</Row> : null}
            <Row label={t('portal.receipt.status')}>{t(v.statusKey)}</Row>
            <Row label={t('portal.receipt.recipient')}>
              {v.recipientName}
              {parties ? <EntityBadge entity={parties.recipientEntity} /> : null}
            </Row>
            {parties?.recipientBusinessName ? <Row label={t('portal.b2b.businessName')}>{parties.recipientBusinessName}</Row> : null}
            <Row label={t('portal.receipt.destination')}>
              <span className="font-mono">
                {payoutMethodLabel(v.payoutMethod)} {v.maskedDestination}
              </span>
            </Row>
            <Row label={t('portal.receipt.youSend')}>
              <Money amount={v.amount} currency={v.currency} />
            </Row>
            <Row label={t('portal.receipt.fee')}>
              <Money amount={v.fee} currency={v.currency} />
            </Row>
            <Row label={t('portal.receipt.total')} strong>
              <Money amount={v.total} currency={v.currency} />
            </Row>
            <Row label={t('portal.receipt.rate')}>
              1 {v.currency} = {v.fxRate} {v.destCurrency}
            </Row>
            <Row label={t('portal.receipt.theyGet')} strong>
              <Money amount={v.amountDest} currency={v.destCurrency} />
            </Row>
          </dl>
          {v.rewardLine ? (
            <p data-reward-line className="mt-3 text-[14px] font-semibold text-ds-ink">
              {v.rewardLine}
            </p>
          ) : null}
        </section>
        {parties ? (
          <section
            data-b2b-payment
            className={`rounded-ds-card border border-ds-border bg-ds-surface p-5 sm:p-6 print:mt-4 print:border-0 print:p-0 ${disclosure ? '' : 'sm:col-span-2'}`}
          >
            <h2 className="text-[16px] font-bold text-ds-ink">{t('portal.b2b.paymentTitle')}</h2>
            <dl className="mt-2 divide-y divide-ds-border">
              <Row label={t('portal.b2b.from')}>
                {fromLabel(parties, owner.phone)}
                <EntityBadge entity={parties.senderEntity} />
              </Row>
              <Row label={t('portal.b2b.funding')}>{fundingLabel(parties)}</Row>
            </dl>
          </section>
        ) : null}
        {disclosure ? <ReceiptDisclosureCard disclosure={disclosure} /> : null}
      </div>
    </>
  );
}
