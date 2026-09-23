import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, type ResolvedBranding } from '@/lib/partner-config';
import { getB2bQuoteStore, resolveCheckoutBillQuote } from '@/lib/b2b-quote-store';
import { billDenomination, quoteCrossBorderBill, quoteBuyerDenominatedBill } from '@/lib/b2b-quote';
import { getFxRates } from '@/lib/rate';
import { isBillExpired } from '@/lib/b2b-bill-expiry';
import { countryForPhone, currencyForPhone } from '@/lib/partner-currency';
import { BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import { BillPayForm } from './bill-pay-form';
import { headers } from 'next/headers';
import { isIpRateLimited, PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';

// Cross-border B2B bill checkout page (Plan 4). The buyer opens /pay/b2b/<invoiceId>:
// the obligation is FIXED in the seller's currency (Case S — we quote the buyer's
// FX equivalent + fees LIVE) or in the BUYER's currency (Case B, 2026-07-02 spec —
// the buyer pays the exact billed amount + fees; the seller's converted receipt is
// quoted LIVE). Either way the quote is LOCKED for the checkout, then we collect
// the buyer's LOCAL bank details + OTP. The transfer is minted at submit time (see
// the route). WhatsApp-dark theme, mirroring /pay/[transferId].

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

// Program-Fix 23: ONE message for every non-payable state (missing, settled,
// voided, unsupported country, inactive seller, third-currency, throttled), with
// DEFAULT branding — a dead link reveals neither the partner nor the bill state.
const INACTIVE_MESSAGE = 'This bill is no longer active';

/** `branding` is passed ONLY for a live, payable bill (the FX-down catch); every dead sheet is default-branded. */
function Inactive({ message, branding }: { message: string; branding?: ResolvedBranding }) {
  const brand = branding ?? resolvePartnerBranding(null);
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={brand} />
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
  // Program-Fix 23: fail-open per-IP guard BEFORE the invoice read. Over budget
  // ⇒ the same generic sheet as a missing bill, never a 429, nothing logged.
  // `headers()` is `Promise<ReadonlyHeaders>` (next/dist/server/request/headers.d.ts:11).
  if (await isIpRateLimited(await headers(), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT)) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }
  const store = getStore();
  const invoice = await store.getB2bInvoice(invoiceId);

  const isCrossBorder =
    !!invoice &&
    !!invoice.sellerId &&
    invoice.invoicedAmount !== undefined &&
    invoice.invoicedAmount > 0 &&
    !!invoice.invoicedCurrency;
  if (!invoice || !isCrossBorder) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }
  // Program-Fix 44: an unpaid bill past the TTL is dead — the same generic sheet.
  if (invoice.status !== 'unpaid' || isBillExpired(invoice)) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }

  const buyerCountry = countryForPhone(invoice.buyerPhone);
  const buyerCurrency = currencyForPhone(invoice.buyerPhone);
  if (!buyerCountry || !buyerCurrency || !BANK_FIELDS_BY_COUNTRY[buyerCountry]) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }

  const seller = await store.getSellerById(invoice.sellerId!);
  if (!seller || seller.status !== 'active' || seller.partnerId !== invoice.partnerId) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }
  const sellerCurrency = seller.currency;
  const invoicedAmount = invoice.invoicedAmount!;
  const invoicedCurrency = invoice.invoicedCurrency!;

  // Denomination model (2026-07-02 spec), DERIVED — no migration. Case S
  // (seller currency — today's model; S === B degenerates there) or Case B
  // (buyer currency — the buyer's price is the fixed side); a third-currency
  // bill is never payable. billDenomination() is the ONE shared authority
  // (this page, the POST route, and the finalize defense can never disagree).
  const denomination = billDenomination(invoicedCurrency, sellerCurrency, buyerCurrency);
  if (!denomination) {
    return <Inactive message={INACTIVE_MESSAGE} />;
  }
  const isBuyerDenominated = denomination === 'buyer';

  // The partner is read only for a PAYABLE bill (Program-Fix 23): its brand
  // dresses the checkout and the FX-down retry sheet, never a dead link.
  const branding = resolvePartnerBranding(await getPartnerStore().getPartner(invoice.partnerId));

  // Live-locked checkout quote — reused on reload, re-quoted on expiry. Wrapped:
  // a QuoteError (bad FX input) or a RateUnavailableError (Task 9: provider
  // down / no rate inside the ceiling) degrades to the friendly Inactive sheet
  // instead of a 500, matching the POST route's 503.
  let quote: Awaited<ReturnType<typeof resolveCheckoutBillQuote>>;
  try {
    const buyerRates = await getFxRates(buyerCurrency);
    quote = await resolveCheckoutBillQuote(
      getB2bQuoteStore(),
      invoiceId,
      async () => {
        const sellerRates = await getFxRates(sellerCurrency);
        const sellerToUsd = sellerCurrency === 'USD' ? 1 : sellerRates.toUsd;
        const input = {
          invoicedAmount,
          sellerCurrency,
          buyerCurrency,
          rates: buyerRates,
          sellerToUsd,
          fundingMethod: 'bank_pull',
        } as const;
        return isBuyerDenominated ? quoteBuyerDenominatedBill(input) : quoteCrossBorderBill(input);
      },
      // A stale lock must still describe THIS obligation — the FIXED side is the
      // one pinned to the invoice (Case S: the seller amount; Case B: the buyer
      // principal); the floating side is whatever that lock quoted.
      (q) =>
        q.buyerCurrency === buyerCurrency &&
        q.sellerCurrency === sellerCurrency &&
        (isBuyerDenominated
          ? Math.round(q.buyerPrincipal * 100) === Math.round(invoicedAmount * 100)
          : Math.round(q.sellerAmount * 100) === Math.round(invoicedAmount * 100)),
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
          {isBuyerDenominated ? (
            <>
              {/* Case B: the bill is fixed in the BUYER's currency — the amount
                  due is exact; the seller's converted receipt is the estimate. */}
              <div className={lineClasses}>
                <span className="text-[#8696a0]">Amount due</span>
                <span>{formatMoney(quote.buyerPrincipal, buyerCurrency)} (exact)</span>
              </div>
              <div className={lineClasses}>
                <span className="text-[#8696a0]">Seller receives</span>
                <span>≈ {formatMoney(quote.sellerAmount, sellerCurrency)}</span>
              </div>
            </>
          ) : (
            <div className={lineClasses}>
              <span className="text-[#8696a0]">Amount due</span>
              <span>{formatMoney(quote.sellerAmount, sellerCurrency)}</span>
            </div>
          )}
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
