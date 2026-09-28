import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Send } from 'lucide-react';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { getRedis } from '@/lib/redis';
import { findByRid } from '@/lib/portal-recipients';
import { hasSenderName } from '@/lib/sender-identity';
import { newRequestKey } from '@/lib/portal-request-key';
import {
  capCopy,
  limitsCopy,
  loadSendReview,
  maskPhone,
  portalKycGate,
  portalToolContext,
  quoteForPortal,
  reviewNotice,
  sendLimitsForPortal,
  type SendCopy,
} from '@/lib/portal-send';
import { t, type MessageKey } from '@/lib/i18n';
import { buttonVariants, Card, EmptyState, Money, PageHeader } from '@/components/ds';
import { KycCard, SendAlert } from '../kyc-card';
import { ContinueForm, NameForm } from './review-forms';

export const metadata: Metadata = { title: t('portal.send.reviewTitle'), referrer: 'no-referrer' };

const FUNDING_LABEL: Record<string, MessageKey> = {
  bank_transfer: 'portal.send.funding.bank_transfer',
  debit_card: 'portal.send.funding.debit_card',
  credit_card: 'portal.send.funding.credit_card',
};

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-[14.5px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-right tabular-nums ${strong ? 'font-bold text-ds-ink' : 'text-ds-ink'}`}>{children}</dd>
    </div>
  );
}

const changeLink = (
  <Link href="/portal/send" className="text-[14px] font-semibold text-ds-primary hover:underline">
    {t('portal.send.edit')}
  </Link>
);

function Refusal({ copy }: { copy: SendCopy }) {
  return (
    <div className="flex flex-col gap-4">
      {copy.kyc ? <KycCard kind={copy.kyc} message={t(copy.error, copy.vars)} /> : <SendAlert message={t(copy.error, copy.vars)} />}
      <p>{changeLink}</p>
    </div>
  );
}

/**
 * Send, step 2: the review (UI redesign M2-9). Every render re-quotes with the bot's own getQuoteTyped
 * and re-reads the bot's cap + EDD check, so a stale price is never shown; neither call can start a
 * provider inquiry (the portal context's KYC provider is non-minting), and a gated customer never
 * reaches them (pure reads first). The in-progress send comes from the customer's own server-side
 * slot, so no name or phone is ever in the URL.
 */
export default async function PortalSendReviewPage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = { partnerId: site.partnerId, phone: ctx.session.phone };
  const review = await loadSendReview(getRedis(), owner).catch(() => null);

  const shell = (children: ReactNode) => (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <PageHeader title={t('portal.send.reviewTitle')} sub={t('portal.send.reviewSub')} />
      {children}
    </div>
  );

  if (!review) {
    return shell(
      <div data-empty>
        <EmptyState
          icon={<Send className="size-5" />}
          title={t('portal.send.noReviewTitle')}
          body={t('portal.send.noReviewBody')}
          action={
            <Link href="/portal/send" className={buttonVariants({ variant: 'primary', size: 'md' })}>
              {t('portal.send.start')}
            </Link>
          }
        />
      </div>,
    );
  }

  const tc = portalToolContext(owner);
  const [customer, partner] = await Promise.all([
    tc.customerStore.getCustomer(owner.partnerId, owner.phone),
    getPartnerStore().getPartner(owner.partnerId),
  ]);
  const gated = portalKycGate(partner, customer, site.brand);
  if (gated) return shell(<Refusal copy={gated} />);

  let recipient: { name: string; phone: string } | null;
  if (review.recipient.kind === 'saved') {
    const r = await findByRid(getDb(), owner.partnerId, owner.phone, review.recipient.rid);
    recipient = r ? { name: r.name, phone: r.recipientPhone } : null;
  } else {
    recipient = { name: review.recipient.name, phone: review.recipient.phone };
  }
  if (!recipient) return shell(<Refusal copy={{ error: 'portal.send.recipient_not_found' }} />);

  if (!hasSenderName(customer)) {
    return shell(
      <Card className="flex flex-col gap-4">
        <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.send.nameTitle')}</h2>
        <p className="text-[14.5px] text-ds-ink-muted">{t('portal.send.nameBody')}</p>
        <NameForm />
      </Card>,
    );
  }

  const limits = await sendLimitsForPortal(owner, { amountSource: review.amountSource, sourceCurrency: review.sourceCurrency });
  const limitRefusal = limitsCopy(limits, site.brand);
  if (limitRefusal) return shell(<Refusal copy={limitRefusal} />);

  let q;
  try {
    q = await quoteForPortal(owner, {
      amountSource: review.amountSource,
      sourceCurrency: review.sourceCurrency,
      destinationCountry: review.destinationCountry,
      fundingMethod: review.fundingMethod,
    });
  } catch {
    return shell(<Refusal copy={{ error: 'portal.send.fx_unavailable' }} />);
  }
  if (q.kind === 'kyc_required') return shell(<Refusal copy={{ error: 'portal.send.kycBody', kyc: 'verify' }} />);
  if (q.kind === 'cap') {
    const ev = q.evaluation;
    return shell(<Refusal copy={capCopy(ev.reason, { todayRemainingUsd: ev.todayRemainingCents / 100, perTransferCapUsd: ev.perTransferCapCents / 100 }, site.brand)} />);
  }
  if (q.kind === 'fx_unavailable') return shell(<Refusal copy={{ error: 'portal.send.fx_unavailable' }} />);
  if (q.kind === 'invalid_request') return shell(<Refusal copy={{ error: 'portal.send.amount_not_allowed' }} />);

  const quote = q.quote;
  const src = quote.sourceCurrency;
  const dest = quote.destinationCurrency ?? 'INR';
  const notice = await reviewNotice(tc.draftStore, owner, review);

  return shell(
    <>
      {notice ? (
        <p role="status" className="rounded-ds-inner border border-ds-border bg-ds-surface px-4 py-3 text-[14px] font-semibold text-ds-ink">
          {t(notice)}
        </p>
      ) : null}
      <Card className="flex flex-col gap-4 p-5 sm:p-6">
        <dl className="divide-y divide-ds-border">
          <Row label={t('portal.send.to')}>
            <span className="font-semibold">{recipient.name}</span> <span className="font-mono text-ds-ink-muted">{maskPhone(recipient.phone)}</span>
          </Row>
          <Row label={t('portal.send.youSend')}>
            <Money amount={quote.amountSource} currency={src} />
          </Row>
          <Row label={t('portal.send.fee')}>
            <Money amount={quote.feeSource} currency={src} />
          </Row>
          <Row label={t('portal.send.total')} strong>
            <Money amount={quote.totalChargeSource} currency={src} />
          </Row>
          <Row label={t('portal.send.rate')}>{t('portal.send.rateValue', { from: src, rate: String(quote.fxRate), to: dest })}</Row>
          <Row label={t('portal.send.theyGet')} strong>
            <Money amount={quote.amountInr} currency={dest} />
          </Row>
          <Row label={t('portal.send.delivery')}>{quote.deliveryEstimate}</Row>
          <Row label={t('portal.send.payingWith')}>{t(FUNDING_LABEL[review.fundingMethod] ?? 'portal.send.funding.bank_transfer')}</Row>
        </dl>
        <p className="text-[13.5px] text-ds-ink-muted">{t('portal.send.payNote', { brand: site.brand })}</p>
        <ContinueForm rv={review.id} requestKey={newRequestKey()} />
        <p>{changeLink}</p>
      </Card>
    </>,
  );
}
