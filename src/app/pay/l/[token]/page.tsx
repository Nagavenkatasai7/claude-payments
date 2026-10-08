import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { getDb } from '@/db/client';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { buildPrepaymentDisclosure } from '@/lib/remittance-disclosure';
import { isIpRateLimited, PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';
import { isInfraError } from '@/lib/infra-error';
import { logWarn } from '@/lib/log';
import { RateUnavailableError } from '@/lib/rate';
import { QuoteError } from '@/lib/fx';
import { PURPOSE_LABELS } from '@/lib/purpose-codes';
import { resolvePayableLink } from '@/lib/payment-link-finalize';
import { getLinkQuoteStore, lockedOrFreshLinkRate } from '@/lib/payment-link-quote';
import { LINK_FUNDING_METHODS, linkQuote, type LinkFundingMethod } from '@/lib/payment-links';
import { DarkSheetBrand } from '@/components/brand/dark-sheet-brand';
import { RemittanceDisclosure } from '../../[transferId]/remittance-disclosure';
import { LinkPayForm, type LinkPayOption } from './link-pay-form';

// Batch B2: the customer's page for one payment link. It shows the company, the
// partner's reference, the exact rupee amount, the locked rate, the fee for each
// way to pay, the USD total and the Reg E disclosure; the form then asks for a
// WhatsApp code and pays (/api/pay/l/[token]). SmartRemit brand only.
//
// Every unpayable state (unknown token, switch off, not a demo phone, payee not
// approved, cancelled, expired, paid) renders the SAME sheet, byte for byte, so
// the page never says which check refused or whether a token exists.

export const metadata: Metadata = { title: 'Secure payment', robots: { index: false, follow: false } };

const pageClasses =
  "flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#e9edef]";
const sheetClasses = 'w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7';
const headingClasses = 'mb-5 text-lg leading-normal font-semibold';

function Sheet({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function InactiveSheet() {
  return <Sheet title="This link is no longer active" />;
}

function TemporaryProblemSheet({ token }: { token: string }) {
  return (
    <Sheet title="We're having a temporary problem">
      <p className="mb-5 text-sm leading-normal text-[#8696a0]">Please try again in a moment.</p>
      <a href={`/pay/l/${encodeURIComponent(token)}`} className="text-sm leading-normal font-semibold text-[#25d366]">
        Try again
      </a>
    </Sheet>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 py-1.5 text-sm leading-normal" style={bold ? { fontWeight: 700 } : undefined}>
      <span className="text-[#8696a0]">{label}</span>
      <span className="min-w-0 break-words text-right">{value}</span>
    </div>
  );
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const METHOD_LABELS: Record<LinkFundingMethod, string> = { bank_transfer: 'Bank transfer', debit_card: 'Debit card' };

type PageProps = { params: Promise<{ token: string }> };

export default async function PaymentLinkPage({ params }: PageProps) {
  const { token } = await params;
  let page: React.ReactNode = null;
  try {
    page = await renderPage(token);
  } catch (err) {
    unstable_rethrow(err);
    if (!isInfraError(err) && !(err instanceof RateUnavailableError)) throw err;
    logWarn('paylink.page', err instanceof Error ? err.name : 'error', {});
  }
  return page ?? <TemporaryProblemSheet token={token} />;
}

async function renderPage(token: string): Promise<React.ReactNode> {
  // Fail-open per-IP guard BEFORE any read; over budget ⇒ the same dead-link sheet.
  if (await isIpRateLimited(await headers(), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT)) return <InactiveSheet />;

  const store = getStore();
  const payable = await resolvePayableLink(getDb(), store, token);
  if (!payable) return <InactiveSheet />;
  const { link, payee, transfer } = payable;
  const partner = await getPartnerStore().getPartner(link.partnerId);
  const disclosureConfig = resolvePartnerDisclosure(partner);

  // The figures per way to pay. A claimed link whose transfer exists (a charge
  // failed before) shows THAT transfer's fixed figures and its one method.
  let options: LinkPayOption[];
  let fxRate: number;
  if (transfer) {
    fxRate = transfer.fxRate;
    options = [{
      method: transfer.fundingMethod as LinkFundingMethod,
      label: METHOD_LABELS[transfer.fundingMethod as LinkFundingMethod] ?? 'Bank transfer',
      amountUsd: transfer.amountUsd,
      feeUsd: transfer.feeUsd,
      totalUsd: transfer.totalChargeUsd,
    }];
  } else {
    const rate = await lockedOrFreshLinkRate(getLinkQuoteStore(), link.id);
    fxRate = rate.toInr;
    try {
      options = LINK_FUNDING_METHODS.map((method) => {
        const q = linkQuote(link.amountInr, rate, method);
        return { method, label: METHOD_LABELS[method], amountUsd: q.amountUsd, feeUsd: q.feeUsd, totalUsd: q.totalChargeUsd };
      });
    } catch (err) {
      if (!(err instanceof QuoteError)) throw err;
      return (
        <Sheet title="This payment can't be made online right now">
          <p className="text-sm leading-normal text-[#8696a0]">
            At today&apos;s exchange rate this amount is outside what can be paid online. Please contact the company.
          </p>
        </Sheet>
      );
    }
  }

  const disclosures: Partial<Record<LinkFundingMethod, React.ReactNode>> = {};
  let disclosureVersion: string | null = null;
  for (const o of options) {
    const d = buildPrepaymentDisclosure(
      {
        transferType: 'b2c',
        sourceAmount: o.amountUsd,
        sourceFee: o.feeUsd,
        sourceTotalCharge: o.totalUsd,
        sourceCurrency: 'USD',
        destAmount: link.amountInr,
        destCurrency: 'INR',
        fxRate,
      },
      disclosureConfig,
    );
    if (d) {
      disclosureVersion = d.version;
      disclosures[o.method] = <RemittanceDisclosure disclosure={d} />;
    }
  }

  return (
    <Sheet title="Secure payment">
      <div className="mb-5 rounded-xl bg-[#202c33] p-3.5">
        <Row label="Pay to" value={payee.legalName} />
        <Row label="Reference" value={link.reference} />
        <Row label="Purpose" value={PURPOSE_LABELS[link.purpose] ?? link.purpose} />
        <Row label="They receive" value={money(link.amountInr, 'INR')} bold />
        <Row label="Exchange rate" value={`1 USD = ${fxRate.toFixed(2)} INR`} />
      </div>
      <LinkPayForm
        token={token}
        options={options}
        disclosures={disclosures}
        disclosureVersion={disclosureVersion}
        receipt={{ payeeName: payee.legalName, reference: link.reference, amountInr: link.amountInr }}
      />
    </Sheet>
  );
}
