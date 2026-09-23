import { getStore } from '@/lib/store';
import { getDraftStore } from '@/lib/draft-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, resolvePartnerDisclosure, type ResolvedBranding } from '@/lib/partner-config';
import { buildPrepaymentDisclosure } from '@/lib/remittance-disclosure';
import type { Partner } from '@/lib/types';
import type { CountryCode } from '@/lib/types';
import { draftTenant } from '@/lib/legacy-tenant';
import { accountLast4, isMaskedDestination } from '@/lib/payout-format';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { PayForm } from './pay-form';
import { RemittanceDisclosure } from './remittance-disclosure';
import { headers } from 'next/headers';
import { isIpRateLimited, PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';

// WL1: the secure pay page renders the PARTNER's brand (name, color, logo) so the
// customer experiences the partner end-to-end. Default/unconfigured ⇒ 'SmartRemit'
// with no color/logo override — byte-for-byte today.
// Tailwind conversion of the legacy WhatsApp-dark theme (legacy-themes.css) — exact
// visual identity. `leading-normal` pins line-height to the inherited 1.5 the
// legacy CSS relied on (named text-* utilities would otherwise change it).
const pageClasses =
  "flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#e9edef]";
const sheetClasses = 'w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7';
const headingClasses = 'mb-5 text-lg leading-normal font-semibold';
const brandClasses = 'mb-1 text-xl leading-normal font-extrabold text-[#25d366]';

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

// ONE partner read feeds both the branding and the Reg E disclosure.
async function loadPartner(partnerId: string | null): Promise<Partner | null> {
  if (!partnerId) return null;
  return getPartnerStore().getPartner(partnerId);
}

/**
 * The ONE dead-link sheet (Program-Fix 23): not-found and throttled render this
 * identical markup with default branding, so the page is never an oracle for
 * whether an id exists.
 */
function InactiveSheet({ branding }: { branding: ResolvedBranding }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>This link is no longer active</h1>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between py-1.5 text-sm leading-normal" style={bold ? { fontWeight: 700 } : undefined}>
      <span className="text-[#8696a0]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** fix 6: last-4 label for a REAL stored destination (this page is link-reachable without OTP — never more than 4 digits). */
function savedAccountLabelFor(dest: string): string {
  const l4 = accountLast4(dest);
  return l4 ? `account ending ${l4}` : 'the saved account';
}

/**
 * Format any amount in any ISO-4217 currency using Intl.NumberFormat.
 * Gives ₹ for INR, £ for GBP, AED for AED, $ for USD, etc.
 * Falls back to a plain numeric string for unrecognised codes.
 */
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

export default async function PayPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const { transferId } = await params;
  // Program-Fix 23: fail-open per-IP guard BEFORE any ledger/draft read. Over
  // budget ⇒ the same sheet as not-found (default brand), never a 429, no log.
  // `headers()` is `Promise<ReadonlyHeaders>` (next/dist/server/request/headers.d.ts:11).
  if (await isIpRateLimited(await headers(), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT)) {
    return <InactiveSheet branding={resolvePartnerBranding(null)} />;
  }
  const transfer = await getStore().getTransfer(transferId);

  // ── Build a unified view object so JSX is shared between both paths ──

  type View = {
    id: string;
    recipientName: string;
    // Destination (recipient) side
    destAmount: number;
    destCurrency: string;
    destinationCountry: CountryCode;
    // Source (sender) side
    sourceAmount: number;
    sourceFee: number;
    sourceTotalCharge: number;
    sourceCurrency: string;
    fundingMethod: string;
    // Program-Fix 15 PR B: the disclosure's rate row and its B2B exclusion.
    fxRate: number;
    transferType: 'b2c' | 'b2b';
    awaitingPayment: boolean;
    // Item 2 (two-step pay page): true whenever no bank string exists yet (a
    // cold-start DRAFT, or a SCHEDULED/cron transfer created with an empty
    // destination) — the sender enters recipient bank details on the secure page.
    // A re-opened link whose destination is already set skips Step 1 (bodyless POST).
    needsBankDetails: boolean;
    savedAccountLabel: string | null; // fix 6: non-null ⇒ the single-step form offers "Edit bank details"
  };

  let view: View | null = null;
  // WL1: the partner that owns this payment — drives the page branding below.
  let brandPartnerId: string | null = null;

  if (transfer) {
    // Program-Fix 32: a cancelled transfer (an expired unpaid link, a staff
    // cancel, an admin reject) is a dead link — the ONE generic sheet with
    // default branding, byte-equal to not-found, and never "Payment complete".
    // Returned before the decrypted payout read. (The POST still refuses it:
    // refuseUnlessAwaiting in api/pay/[transferId]/route.ts.)
    if (transfer.status === 'cancelled') {
      return <InactiveSheet branding={resolvePartnerBranding(null)} />;
    }
    brandPartnerId = transfer.partnerId;
    // fix 6 (ctx-01): decide Step 1 and the Edit offer on the explicit decrypted
    // read (boolean + last-4 label only); Edit only where the guarded write would
    // accept it (consumer, uncharged, awaiting, not partner-API-minted).
    const storedTransferDest =
      ((await getStore().getTransferDecrypted(transferId))?.payoutDestination ?? '').trim();
    const transferNeedsDetails = storedTransferDest === '' || isMaskedDestination(storedTransferDest);
    const transferEditable =
      !transferNeedsDetails && (await createTransferRepo(getDb()).isPayoutEditable(transfer.id, transfer.partnerId));
    const destCurrency: string = transfer.destinationCurrency ?? 'INR';
    const sourceCurrency: string = transfer.sourceCurrency ?? 'USD';
    view = {
      id: transfer.id,
      recipientName: transfer.recipientName,
      destAmount: transfer.amountInr,
      destCurrency,
      destinationCountry: transfer.destinationCountry ?? 'IN',
      sourceAmount: transfer.amountSource ?? transfer.amountUsd,
      sourceFee: transfer.feeSource ?? transfer.feeUsd,
      sourceTotalCharge: transfer.totalChargeSource ?? transfer.totalChargeUsd,
      sourceCurrency,
      fundingMethod: transfer.fundingMethod,
      fxRate: transfer.fxRate,
      transferType: transfer.transferType ?? 'b2c',
      awaitingPayment: transfer.status === 'awaiting_payment',
      // Usually a re-opened link with the destination already set → skip Step 1.
      // But a SCHEDULED/cron transfer is created with an EMPTY destination (Item
      // 2: never collected in chat) — collect the recipient's bank details here.
      needsBankDetails: transferNeedsDetails,
      savedAccountLabel: transferEditable ? savedAccountLabelFor(storedTransferDest) : null,
    };
  } else {
    // Dual-lookup: treat the segment as a draftId
    const draft = await getDraftStore().getDraft(transferId);
    if (draft) {
      // The draft carries its tenant (fix 1); a pre-deploy draft brands by the oldest-row rule.
      brandPartnerId = await draftTenant(draft, getStore().legacyTenantOf);
      const destCurrency: string = draft.quote.destinationCurrency ?? draft.destinationCurrency ?? 'INR';
      const sourceCurrency: string = draft.sourceCurrency ?? 'USD';
      const feeSource = draft.quote.feeSource ?? draft.quote.feeUsd;
      const totalChargeSource =
        draft.quote.totalChargeSource ??
        draft.quote.totalChargeUsd ??
        draft.amountSource + feeSource;
      // A cold-start draft carries NO bank string (Item 2). A draft carrying a REAL
      // stored destination (rehydrated server-side) skips Step 1 but offers "Edit bank
      // details" on a consumer draft. fix 6: a MASKED placeholder is not a stored
      // destination — collect it on Step 1 like a cold start.
      const storedDraftDest = (draft.recipient.payoutDestination ?? '').trim();
      const hasStoredDest = storedDraftDest !== '' && !isMaskedDestination(storedDraftDest);
      view = {
        id: transferId,
        recipientName: draft.recipient.name,
        destAmount: draft.quote.amountInr,
        destCurrency,
        destinationCountry: draft.destinationCountry ?? 'IN',
        sourceAmount: draft.amountSource,
        sourceFee: feeSource,
        sourceTotalCharge: totalChargeSource,
        sourceCurrency,
        fundingMethod: draft.fundingMethod,
        fxRate: draft.quote.fxRate,
        transferType: draft.transferType ?? 'b2c',
        awaitingPayment: true, // a draft is always awaiting payment
        needsBankDetails: !hasStoredDest,
        savedAccountLabel: hasStoredDest && draft.transferType !== 'b2b' ? savedAccountLabelFor(storedDraftDest) : null,
      };
    }
  }

  const partner = await loadPartner(brandPartnerId);
  const branding = resolvePartnerBranding(partner);

  if (!view) {
    return <InactiveSheet branding={branding} />;
  }

  // Program-Fix 15 PR B: the Reg E pre-payment disclosure (null for B2B). The
  // amounts are the view's own — the card can never disagree with the form.
  const disclosure = view.awaitingPayment
    ? buildPrepaymentDisclosure(view, resolvePartnerDisclosure(partner))
    : null;

  const feeLabel =
    view.sourceFee === 0
      ? 'FREE'
      : formatMoney(view.sourceFee, view.sourceCurrency);

  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>Secure payment</h1>
        <div className="mb-5 rounded-xl bg-[#202c33] p-3.5">
          <Row label="Recipient" value={view.recipientName} />
          <Row
            label="They receive"
            value={formatMoney(view.destAmount, view.destCurrency)}
          />
          <Row
            label="Amount"
            value={formatMoney(view.sourceAmount, view.sourceCurrency)}
          />
          <Row label="Fee" value={feeLabel} />
          <Row
            label="Total charge"
            value={formatMoney(view.sourceTotalCharge, view.sourceCurrency)}
            bold
          />
          <Row
            label="Paying with"
            value={view.fundingMethod === 'ach_pull' ? 'ACH bank debit' : 'Bank transfer'}
          />
        </div>
        {disclosure && <RemittanceDisclosure disclosure={disclosure} />}
        {view.awaitingPayment ? (
          <PayForm
            disclosureVersion={disclosure?.version ?? null}
            transferId={view.id}
            destinationCountry={view.destinationCountry}
            needsBankDetails={view.needsBankDetails}
            savedAccountLabel={view.savedAccountLabel}
            recipientName={view.recipientName}
            fundingMethod={view.fundingMethod}
            summary={{
              destAmount: view.destAmount,
              destCurrency: view.destCurrency,
              sourceAmount: view.sourceAmount,
              sourceCurrency: view.sourceCurrency,
              sourceTotalCharge: view.sourceTotalCharge,
            }}
          />
        ) : (
          <p className="flex items-center justify-center gap-2 font-semibold text-[#25d366]">
            {/* Inline SVG check (not the ✅ emoji) so the success state renders
                identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
            <svg
              className="shrink-0"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12.5l2.5 2.5L16 9" />
            </svg>
            Payment complete &mdash; money sent!
          </p>
        )}
      </div>
    </main>
  );
}
