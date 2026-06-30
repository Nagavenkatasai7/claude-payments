import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, type ResolvedBranding } from '@/lib/partner-config';
import { getB2bQuoteStore, resolveCheckoutBillQuote } from '@/lib/b2b-quote-store';
import { quoteCrossBorderBill } from '@/lib/b2b-quote';
import { getFxRates } from '@/lib/rate';
import { countryForPhone, currencyForPhone } from '@/lib/partner-currency';
import { BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import { BillPayForm } from './bill-pay-form';

// Cross-border B2B bill checkout page (Plan 4). The buyer opens /pay/b2b/<invoiceId>:
// the obligation is FIXED in the seller's currency; we quote the buyer's FX
// equivalent + fees LIVE and LOCK it for the checkout, then collect the buyer's
// LOCAL bank details + OTP. The transfer is minted at submit time (see the route).
// WhatsApp-dark theme, mirroring /pay/[transferId].

const pageClasses =
  "flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#e9edef]";
const sheetClasses = 'w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7';
const headingClasses = 'mb-5 text-lg leading-normal font-semibold';
const brandClasses = 'mb-1 text-xl leading-normal font-extrabold text-[#25d366]';
const lineClasses = 'flex justify-between py-1.5 text-sm leading-normal';

function Brand({ branding }: { branding: ResolvedBranding }) {
  if (branding.logoUrl) {
    return (
      <div className={brandClasses}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={branding.logoUrl} alt={branding.brand} style={{ maxHeight: 28, verticalAlign: 'middle' }} />
      </div>
    );
  }
  return (
    <div className={brandClasses} style={branding.primaryColor ? { color: branding.primaryColor } : undefined}>
      {branding.brand}
    </div>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function Inactive({ branding, message }: { branding: ResolvedBranding; message: string }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>{message}</h1>
      </div>
    </main>
  );
}

export default async function CrossBorderBillPayPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const store = getStore();
  const invoice = await store.getB2bInvoice(invoiceId);
  const branding = resolvePartnerBranding(
    invoice ? await getPartnerStore().getPartner(invoice.partnerId) : null,
  );

  const isCrossBorder =
    !!invoice &&
    !!invoice.sellerId &&
    invoice.invoicedAmount !== undefined &&
    invoice.invoicedAmount > 0 &&
    !!invoice.invoicedCurrency;
  if (!invoice || !isCrossBorder) {
    return <Inactive branding={branding} message="This bill is no longer active" />;
  }
  if (invoice.status !== 'unpaid') {
    return <Inactive branding={branding} message="This bill has already been settled" />;
  }

  const buyerCountry = countryForPhone(invoice.buyerPhone);
  const buyerCurrency = currencyForPhone(invoice.buyerPhone);
  if (!buyerCountry || !buyerCurrency || !BANK_FIELDS_BY_COUNTRY[buyerCountry]) {
    return <Inactive branding={branding} message="We can't accept a payment from your country yet" />;
  }

  const seller = await store.getSellerById(invoice.sellerId!);
  if (!seller || seller.status !== 'active' || seller.partnerId !== invoice.partnerId) {
    return <Inactive branding={branding} message="This bill is no longer payable" />;
  }
  const sellerCurrency = seller.currency;
  const invoicedAmount = invoice.invoicedAmount!;

  // Live-locked checkout quote — reused on reload, re-quoted on expiry. Wrapped:
  // a QuoteError (bad/unavailable FX) degrades to the friendly Inactive sheet
  // instead of a 500, matching the POST route's graceful failure.
  let quote: Awaited<ReturnType<typeof resolveCheckoutBillQuote>>;
  try {
    const buyerRates = await getFxRates(buyerCurrency);
    quote = await resolveCheckoutBillQuote(
      getB2bQuoteStore(),
      invoiceId,
      async () => {
        const sellerRates = await getFxRates(sellerCurrency);
        const sellerToUsd = sellerCurrency === 'USD' ? 1 : sellerRates.toUsd;
        return quoteCrossBorderBill({
          invoicedAmount,
          sellerCurrency,
          buyerCurrency,
          rates: buyerRates,
          sellerToUsd,
          fundingMethod: 'bank_pull',
        });
      },
      (q) =>
        q.buyerCurrency === buyerCurrency &&
        q.sellerCurrency === sellerCurrency &&
        Math.round(q.sellerAmount * 100) === Math.round(invoicedAmount * 100),
    );
  } catch {
    return <Inactive branding={branding} message="This bill can't be paid right now — please try again shortly" />;
  }

  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>Pay your bill</h1>
        <div className="mb-5 rounded-xl bg-[#202c33] p-3.5">
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Bill from</span>
            <span>{seller.businessName}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Amount due</span>
            <span>{formatMoney(quote.sellerAmount, sellerCurrency)}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Exchange rate</span>
            <span>
              1 {buyerCurrency} ≈ {quote.fxRate.toFixed(4)} {sellerCurrency}
            </span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Fee</span>
            <span>{formatMoney(quote.feeBuyer, buyerCurrency)}</span>
          </div>
          <div className={lineClasses} style={{ fontWeight: 700 }}>
            <span className="text-[#8696a0]">You pay (incl. fees)</span>
            <span>{formatMoney(quote.buyerTotal, buyerCurrency)}</span>
          </div>
        </div>
        <BillPayForm
          invoiceId={invoiceId}
          buyerCountry={buyerCountry}
          sellerBusinessName={seller.businessName}
          buyerTotal={quote.buyerTotal}
          buyerCurrency={buyerCurrency}
        />
      </div>
    </main>
  );
}
