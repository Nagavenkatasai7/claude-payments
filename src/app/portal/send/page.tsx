import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { getRedis } from '@/lib/redis';
import { recipientRid } from '@/lib/portal-recipients';
import { maskAccount } from '@/lib/tools';
import { allowedSendCurrencies, countryForPhone } from '@/lib/partner-currency';
import { quoteCeilingUsd, resolveEffectiveSendLimits } from '@/lib/send-limits';
import {
  loadSendReview,
  parsePrefill,
  portalKycGate,
  portalToolContext,
  PORTAL_DESTINATIONS,
  PORTAL_FUNDING_METHODS,
  type PortalFundingMethod,
} from '@/lib/portal-send';
import { t, type MessageKey } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { KycCard } from './kyc-card';
import { SendForm } from './send-form';

export const metadata: Metadata = { title: t('portal.send.title'), referrer: 'no-referrer' };

const FUNDING_LABEL: Record<PortalFundingMethod, MessageKey> = {
  bank_transfer: 'portal.send.funding.bank_transfer',
  debit_card: 'portal.send.funding.debit_card',
  credit_card: 'portal.send.funding.credit_card',
};

const regionName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * Send, step 1 (UI redesign M2-9): amount, currency, destination, how you pay, and the recipient.
 * Read-only: no quote, no draft and no provider call on this GET. A gated customer sees the identity
 * card instead of the form (pure reads, kyc-gate.ts). Home-send H2: `?amount=&to=` (and the Recipients
 * page's `?r=<rid>`) are initial values only, validated on the server and dropped when doubtful; a rid
 * pre-selects only a live recipient in THIS customer's own book.
 */
export default async function PortalSendPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = { partnerId: site.partnerId, phone: ctx.session.phone };
  const [partner, customer] = await Promise.all([
    getPartnerStore().getPartner(site.partnerId),
    portalToolContext(owner).customerStore.getCustomer(owner.partnerId, owner.phone),
  ]);
  const gated = portalKycGate(partner, customer, site.brand);

  let body;
  if (gated) {
    body = <KycCard kind={gated.kyc ?? 'verify'} message={t(gated.error, gated.vars)} />;
  } else {
    const [book, previous, sp] = await Promise.all([
      createRecipientRepo(getDb()).listAllForSender(owner.partnerId, owner.phone),
      loadSendReview(getRedis(), owner).catch(() => null),
      searchParams,
    ]);
    const saved = book.map((r) => ({
      rid: recipientRid(owner.partnerId, owner.phone, r.recipientPhone),
      name: r.name,
      masked: maskAccount(r.payoutMethod, r.payoutDestination),
      country: countryForPhone(r.recipientPhone),
    }));
    const currencies = partner ? allowedSendCurrencies(partner) : ['USD'];
    const prefill = parsePrefill(sp, {
      ceilingUsd: quoteCeilingUsd(resolveEffectiveSendLimits(partner, customer)),
      sourceCurrency: currencies.length === 1 ? currencies[0] : '',
    });
    const picked = saved.find((r) => r.rid === prefill.rid);
    const hasQuery = prefill.amount !== undefined || prefill.to !== undefined || picked !== undefined;
    // "Change details" comes back here: the customer's own review slot fills the form (no query).
    const fromReview = !hasQuery && previous ? previous : null;
    const prevRecipient = fromReview?.recipient.kind === 'saved' && saved.some((r) => r.rid === (fromReview.recipient as { rid: string }).rid)
      ? (fromReview.recipient as { rid: string }).rid
      : fromReview?.recipient.kind === 'new' ? 'new' : '';
    const pickedCountry = picked?.country && PORTAL_DESTINATIONS.includes(picked.country) ? picked.country : undefined;
    const initial = {
      amount: prefill.amount ?? (fromReview ? fromReview.amountSource.toFixed(2) : ''),
      currency: fromReview?.sourceCurrency ?? currencies[0] ?? 'USD',
      destination: prefill.to ?? pickedCountry ?? fromReview?.destinationCountry ?? 'IN',
      funding: fromReview?.fundingMethod ?? 'bank_transfer',
      recipient: picked?.rid ?? prevRecipient,
      // The customer's own earlier entry, rendered back to them only (never in a URL).
      ...(!picked && fromReview?.recipient.kind === 'new' ? { name: fromReview.recipient.name, phone: `+${fromReview.recipient.phone}` } : {}),
    };
    body = (
      <Card>
        <SendForm
          currencies={currencies}
          destinations={PORTAL_DESTINATIONS.map((code) => ({ code, name: regionName(code) })).sort((a, b) => a.name.localeCompare(b.name))}
          funding={PORTAL_FUNDING_METHODS.map((value) => ({ value, label: FUNDING_LABEL[value] }))}
          saved={saved.map(({ rid, name, masked }) => ({ rid, name, masked }))}
          initial={initial}
        />
      </Card>
    );
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <PageHeader title={t('portal.send.title')} sub={t('portal.send.sub')} />
      {body}
    </div>
  );
}
