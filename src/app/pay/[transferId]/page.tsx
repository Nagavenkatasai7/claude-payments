import { getStore } from '@/lib/store';
import { getDraftStore } from '@/lib/draft-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import {
  buildPrepaymentDisclosure,
  buildReceiptDisclosure,
  deliveryDaysFor,
  receiptFromSnapshot,
  type DisclosureSnapshotV1,
  type ReceiptDisclosure,
  type ReceiptTransfer,
} from '@/lib/remittance-disclosure';
import { providerLineFor, providerLineFromSnapshot } from '@/lib/legal/provider-line';
import { approvingAmountText } from '@/lib/approving-line';
import type { Partner } from '@/lib/types';
import type { CountryCode } from '@/lib/types';
import { draftTenant } from '@/lib/legacy-tenant';
import { accountLast4, isMaskedDestination } from '@/lib/payout-format';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { transferMintedFromDraft } from '@/lib/pay-link';
import { PayForm } from './pay-form';
import { RemittanceDisclosure } from './remittance-disclosure';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { isIpRateLimited, PAY_PAGE_IP_LIMIT, PAY_PAGE_SCOPE } from '@/lib/ip-rate-limit';
import { isInfraError } from '@/lib/infra-error';
import { retryOnceOnInfra } from '@/lib/infra-retry';
import { logWarn } from '@/lib/log';
import { DarkSheetBrand } from '@/components/brand/dark-sheet-brand';
import { transferRewardOrNull } from '@/lib/rewards/read';
import { rewardPayNote } from '@/lib/rewards/engine';
import { usdToSource } from '@/lib/rewards/customer';
import { bankDetailsLocked, preparedByLine } from '@/lib/pay-prepared-by';
import { readLegalNameView } from '@/lib/recipient-legal-name';
import { railPartnerOf } from '@/lib/live-gate';
import { NO_ORIGINATOR_FIELDS, readOriginatorView, type OriginatorView } from '@/lib/originator-info';
import { DEFAULT_DESTINATION_COUNTRY } from '@/lib/defaults';
import { readEsignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { isRiskSignal } from '@/lib/risk-signals';
import { isOpaqueTransferId } from '@/lib/id';
import { payReceiptState, type PayReceiptState } from '@/lib/pay-receipt-state';
import { FIXED_REPLIES } from '@/lib/hold-replies';
import {
  PAY_RECEIPT_CANCELLED_CHARGED_COPY,
  PAY_RECEIPT_NOT_COMPLETED_COPY,
  PAY_RECEIPT_PRINT_HINT,
  PAY_RECEIPT_REFUNDED_COPY,
} from '@/lib/pay-outcome';
import { PayReceipt } from './pay-receipt';

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
// Fix pack 6 (P11): only a page that renders a receipt prints white with dark text; every
// other page keeps the classes above byte for byte.
const receiptPageClasses = pageClasses + ' print:bg-white print:p-0 print:text-black';
const receiptSheetClasses = sheetClasses + ' print:max-w-none print:bg-white print:p-0';
const summaryClasses = 'mb-5 rounded-xl bg-[#202c33] p-3.5';
const receiptSummaryClasses = summaryClasses + ' print:bg-white print:px-0';
const neutralClasses = 'text-center font-semibold text-[#e9edef] print:text-black';

// ONE partner read feeds the Reg E disclosure (the brand is always SmartRemit).
async function loadPartner(partnerId: string | null): Promise<Partner | null> {
  if (!partnerId) return null;
  return getPartnerStore().getPartner(partnerId);
}

/**
 * The ONE dead-link sheet (Program-Fix 23): not-found and throttled render this
 * identical markup with default branding, so the page is never an oracle for
 * whether an id exists.
 */
function InactiveSheet() {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>This link is no longer active</h1>
      </div>
    </main>
  );
}

/**
 * Fix pack 6 (P11, critic M2): a cancelled 22-char row that was charged (paid, then held and
 * rejected; a refund in flight or done) is not a dead link: its stage-1 message carried this
 * page's link. The dead-link chrome with one fixed line; no snapshot, payout or provider read.
 */
function ChargedCancelledSheet({ copy }: { copy: string }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>{copy}</h1>
      </div>
    </main>
  );
}

/**
 * Fix D: a Redis / Neon infrastructure failure while loading the page. Default
 * branding (the tenant is unknown when the read failed); a plain link retries
 * with no client JS.
 */
function TemporaryProblemSheet({ transferId }: { transferId: string }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>We&apos;re having a temporary problem</h1>
        <p className="mb-5 text-sm leading-normal text-[#8696a0]">Please try again in a moment.</p>
        <a href={`/pay/${encodeURIComponent(transferId)}`} className="text-sm leading-normal font-semibold text-[#25d366]">
          Try again
        </a>
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

type PayPageProps = { params: Promise<{ transferId: string }> };

/**
 * Fix D: an infrastructure error anywhere in the render shows the
 * temporary-problem sheet instead of the root error page. Next's own
 * control-flow errors (unstable_rethrow, node_modules/next/dist/docs/01-app/
 * 03-api-reference/04-functions/unstable_rethrow.md:46-62) and every non-infra
 * error are rethrown untouched. No JSX inside the try.
 */
export default async function PayPage({ params }: PayPageProps) {
  const { transferId } = await params;
  let page: Awaited<ReturnType<typeof renderPayPage>> | null = null;
  try {
    page = await renderPayPage(transferId);
  } catch (err) {
    unstable_rethrow(err);
    if (!isInfraError(err)) throw err;
    logWarn('pay.page-infra', err, { transferId });
  }
  return page ?? <TemporaryProblemSheet transferId={transferId} />;
}

async function renderPayPage(transferId: string) {
  // Program-Fix 23: fail-open per-IP guard BEFORE any ledger/draft read. Over
  // budget ⇒ the same sheet as not-found (default brand), never a 429, no log.
  // `headers()` is `Promise<ReadonlyHeaders>` (next/dist/server/request/headers.d.ts:11).
  if (await isIpRateLimited(await headers(), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT)) {
    return <InactiveSheet />;
  }
  let transfer = await getStore().getTransfer(transferId);
  // Dual-lookup: no transfer ⇒ treat the segment as a draftId.
  // Fix D: an idempotent PEEK, so a Redis blip gets one retry.
  const draft = transfer ? null : await retryOnceOnInfra(() => getDraftStore().getDraft(transferId));
  // Step 0 Q16 (build-changes B.2): a draft link whose draft was minted and
  // consumed (a failed capture after the mint) renders the transfer it BECAME,
  // exactly as that transfer's own link (the form then posts to its id).
  if (!transfer && !draft) transfer = await transferMintedFromDraft(getDb(), getStore(), transferId);

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
    // B3 rewards v1: the reward the price carries (the draft's quote, or the minted
    // transfer's redemption row), shown above the legal disclosure. Null: none.
    rewardNote: string | null;
    // Stage C2: "Prepared in <app>" for a draft an AI app prepared (MCP). Null: none.
    preparedByNote: string | null;
    bankDetailsLocked: boolean; // true ⇒ no "Edit bank details" (Stage C2)
    // Fix pack 4 (C15, critic P2/C10): the 'Approving ...' line's last 4 digits,
    // only where savedAccountLabel is shown today and only for a bank account
    // (a UPI id's digits can be a phone number). Null: no 'account ending'.
    approvingLast4: string | null;
    // Fix pack 4 (C18, T16): the account-holder field. Two booleans only; a
    // stored legal name never reaches the props or the markup.
    legalNameRequired: boolean;
    legalNameOnFile: boolean;
    // Fix pack 5 (P19, T21b): the sender's address / date-of-birth fields. Four
    // booleans only; a stored address or DOB never reaches the props or the markup.
    originator: OriginatorView;
    // Fix pack 6 (R46, P8): the E-SIGN consent version to ask for; null = consent on
    // file, an ACH-debit payment (exempt, P5) or not awaiting payment (page unchanged).
    esignVersion: string | null;
    // Fix pack 6 (P11): the reloaded page would show a printable receipt (b2c, not 'test', a
    // 22-char id or a draft, which mints one); the form's done state then says so.
    receiptOnReload: boolean;
    // Fix pack 6 (R48, P19): the draft carries a known risk signal -> the form shows the fixed
    // warning and its tick. Always false for a minted transfer (no read, no log).
    riskWarning: boolean;
  };

  // A row that is no longer payable, b2b or exempt: no field (and no read).
  const NO_LEGAL_NAME_FIELD = { legalNameRequired: false, legalNameOnFile: true } as const;

  let view: View | null = null;
  // WL1: the partner that owns this payment — drives the Reg E disclosure below.
  let brandPartnerId: string | null = null;
  // Fix pack 6 (P11): the transfer row's state in the status table (a draft is always 'form').
  let receiptState: PayReceiptState = 'form';

  if (transfer) {
    // Program-Fix 32: a cancelled transfer (an expired unpaid link, a staff
    // cancel, an admin reject) is a dead link — the ONE generic sheet with
    // default branding, byte-equal to not-found, and never "Payment complete".
    // Returned before the decrypted payout read. (The POST still refuses it:
    // refuseUnlessAwaiting in api/pay/[transferId]/route.ts.)
    // Fix pack 6 (P11, critic M2): a charged cancel is not a dead link (unless it is a
    // payment-link transfer). A never-charged one returns before any new query.
    if (transfer.status === 'cancelled') {
      const st = payReceiptState(transfer);
      if (st === null || (await createTransferRepo(getDb()).isPaymentLinkTransfer(transfer.id))) return <InactiveSheet />;
      return <ChargedCancelledSheet copy={st === 'refunded' ? PAY_RECEIPT_REFUNDED_COPY : PAY_RECEIPT_CANCELLED_CHARGED_COPY} />;
    }
    // Batch B2: a payment-link transfer is paid only on its link page
    // (/pay/l/[token]), which re-runs the link checks; the POST here refuses it
    // too. Here it is a dead link: no payable form, no payee figures.
    if (await createTransferRepo(getDb()).isPaymentLinkTransfer(transfer.id)) {
      return <InactiveSheet />;
    }
    receiptState = payReceiptState(transfer) ?? 'legacy_complete';
    brandPartnerId = transfer.partnerId;
    // fix 6 (ctx-01): decide Step 1 and the Edit offer on the explicit decrypted
    // read (boolean + last-4 label only); Edit only where the guarded write would
    // accept it (consumer, uncharged, awaiting, not partner-API-minted).
    const storedTransferDest =
      ((await getStore().getTransferDecrypted(transfer.id))?.payoutDestination ?? '').trim();
    const transferNeedsDetails = storedTransferDest === '' || isMaskedDestination(storedTransferDest);
    const transferEditable =
      !transferNeedsDetails && (await createTransferRepo(getDb()).isPayoutEditable(transfer.id, transfer.partnerId));
    const destCurrency: string = transfer.destinationCurrency ?? 'INR';
    const sourceCurrency: string = transfer.sourceCurrency ?? 'USD';
    const reward =
      transfer.status === 'awaiting_payment' ? await transferRewardOrNull(getDb(), transfer.partnerId, transfer.id) : null;
    const transferType = transfer.transferType ?? 'b2c';
    // Fix pack 4 (C18): read only while the row awaits payment (never throws).
    const legalName =
      transfer.status === 'awaiting_payment'
        ? await readLegalNameView(getDb(), {
            ownerId: transfer.partnerId,
            railPartnerId: railPartnerOf(transfer),
            environment: transfer.environment,
            transferType,
            transfer: { id: transfer.id, partnerId: transfer.partnerId },
          })
        : NO_LEGAL_NAME_FIELD;
    // Fix pack 5 (P19): read only while the row awaits payment (never throws).
    // b2b, routed, exempt, sandbox and non-real-money rows -> NO_ORIGINATOR_FIELDS.
    const originator =
      transfer.status === 'awaiting_payment'
        ? await readOriginatorView(getDb(), {
            ownerId: transfer.partnerId,
            railPartnerId: railPartnerOf(transfer),
            environment: transfer.environment,
            transferType,
            subject: {
              partnerId: transfer.partnerId,
              phone: transfer.phone,
              amountUsd: transfer.amountUsd,
              destinationCountry: transfer.destinationCountry,
              transferType,
              transferId: transfer.id,
              routed: !!transfer.settlementPartnerId,
            },
          })
        : NO_ORIGINATOR_FIELDS;
    // Fix pack 6 (P5, P8): ask for E-SIGN consent while the row awaits payment and is not
    // an ACH debit (a non-ACH b2b row is asked too). Owner + sender; never throws (a read
    // error asks).
    const esignVersion =
      transfer.status === 'awaiting_payment' && transfer.fundingMethod !== 'ach_pull'
        ? (await readEsignConsentNeeded(getDb(), transfer.partnerId, transfer.phone))
          ? ESIGN_CONSENT_VERSION
          : null
        : null;
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
      transferType,
      awaitingPayment: transfer.status === 'awaiting_payment',
      // Usually a re-opened link with the destination already set → skip Step 1.
      // But a SCHEDULED/cron transfer is created with an EMPTY destination (Item
      // 2: never collected in chat) — collect the recipient's bank details here.
      needsBankDetails: transferNeedsDetails,
      savedAccountLabel: transferEditable ? savedAccountLabelFor(storedTransferDest) : null,
      approvingLast4: transferEditable && transfer.payoutMethod === 'bank' ? accountLast4(storedTransferDest) || null : null,
      rewardNote: reward
        ? rewardPayNote(reward, (usd) =>
            formatMoney(usdToSource(usd, sourceCurrency, transfer.amountSource, transfer.amountUsd), sourceCurrency),
          )
        : null,
      // A minted transfer has no draft marker (no ledger column, owner decision 2026-10-18).
      preparedByNote: null,
      bankDetailsLocked: false,
      legalNameRequired: legalName.legalNameRequired,
      legalNameOnFile: legalName.legalNameOnFile,
      originator,
      esignVersion,
      receiptOnReload: transferType === 'b2c' && transfer.environment !== 'test' && isOpaqueTransferId(transfer.id),
      riskWarning: false,
    };
  } else if (draft) {
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
    // Fix pack 4 (C18): owner = the draft's tenant, rail = its routed partner (never throws).
    const legalName = await readLegalNameView(getDb(), {
      ownerId: brandPartnerId,
      railPartnerId: draft.settlementPartnerId ?? brandPartnerId,
      environment: undefined,
      transferType: draft.transferType ?? 'b2c',
      draft,
    });
    // Fix pack 5 (P19): the draft's amount and destination, as the pay route asks (never throws).
    const originator = await readOriginatorView(getDb(), {
      ownerId: brandPartnerId,
      railPartnerId: draft.settlementPartnerId ?? brandPartnerId,
      environment: undefined,
      transferType: draft.transferType ?? 'b2c',
      subject: {
        partnerId: brandPartnerId,
        phone: draft.senderPhone,
        amountUsd: draft.amountUsd,
        destinationCountry: draft.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY,
        transferType: draft.transferType ?? 'b2c',
        routed: !!draft.settlementPartnerId,
      },
    });
    // Fix pack 6 (P5, P8): the draft's owner and sender, unless it is an ACH debit (never throws).
    const esignVersion =
      draft.fundingMethod !== 'ach_pull'
        ? (await readEsignConsentNeeded(getDb(), brandPartnerId, draft.senderPhone))
          ? ESIGN_CONSENT_VERSION
          : null
        : null;
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
      approvingLast4:
        hasStoredDest && draft.transferType !== 'b2b' && draft.recipient.payoutMethod === 'bank'
          ? accountLast4(storedDraftDest) || null
          : null,
      bankDetailsLocked: bankDetailsLocked(draft), // Stage C2: an app-prepared draft pays only its stored account
      rewardNote: draft.reward
        ? rewardPayNote(draft.reward, (usd) =>
            formatMoney(usdToSource(usd, sourceCurrency, draft.amountSource, draft.amountUsd), sourceCurrency),
          )
        : null,
      preparedByNote: preparedByLine(draft.preparedBy),
      legalNameRequired: legalName.legalNameRequired,
      legalNameOnFile: legalName.legalNameOnFile,
      originator,
      esignVersion,
      receiptOnReload: (draft.transferType ?? 'b2c') === 'b2c',
      // The same filter as the pay route's tick (T27): an unknown value never asks.
      riskWarning: (draft.riskSignals ?? []).some(isRiskSignal),
    };
  }

  const partner = await loadPartner(brandPartnerId);

  if (!view) {
    return <InactiveSheet />;
  }

  // Program-Fix 15 PR B: the Reg E pre-payment disclosure (null for B2B). The
  // amounts are the view's own — the card can never disagree with the form.
  // Fix pack 4 (C10): one resolve feeds the card and the hash the form posts.
  const resolvedDisclosure = resolvePartnerDisclosure(partner);
  // Fix pack 4 (C21): a minted transfer shows the days stored on it at mint
  // (none stored -> the partner's current value); a draft has none stored.
  const forPage = transfer
    ? { ...resolvedDisclosure, deliveryBusinessDays: deliveryDaysFor(transfer, resolvedDisclosure) }
    : resolvedDisclosure;
  // Fix pack 4 (C22 a, R16): the owner's approved provider line, from the same
  // resolve (never a second one). Null keeps the page byte-identical.
  let providerLine = providerLineFor(resolvedDisclosure);
  // Fix pack 6 (P11): a paid / delivered / held 22-char row gets a receipt: what the customer
  // acknowledged (the snapshot, surface 'transfer') or else the live owner configuration (the
  // portal rule). One tenant-scoped snapshot read; a read error falls back to live (logged).
  let receipt: ReceiptDisclosure | null = null;
  if (transfer && (receiptState === 'complete_receipt' || receiptState === 'held_receipt')) {
    let snap: DisclosureSnapshotV1 | null = null;
    try {
      snap = await createTransferRepo(getDb()).getDisclosureSnapshot(transfer.id, transfer.partnerId);
    } catch (err) {
      logWarn('pay.receipt-snapshot', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
    }
    const acknowledged = snap && snap.surface === 'transfer' ? snap : null;
    const rt: ReceiptTransfer = {
      transferType: transfer.transferType,
      status: transfer.status,
      amountSource: transfer.amountSource ?? transfer.amountUsd,
      feeSource: transfer.feeSource ?? transfer.feeUsd,
      totalChargeSource: transfer.totalChargeSource ?? transfer.totalChargeUsd,
      sourceCurrency: transfer.sourceCurrency ?? 'USD',
      amountInr: transfer.amountInr,
      destinationCurrency: transfer.destinationCurrency ?? 'INR',
      fxRate: transfer.fxRate,
      paidAt: transfer.paidAt,
      deliveredAt: transfer.deliveredAt,
      deliveryBusinessDays: transfer.deliveryBusinessDays,
    };
    receipt = acknowledged
      ? receiptFromSnapshot(acknowledged, rt, Date.now())
      : buildReceiptDisclosure(rt, resolvedDisclosure, Date.now());
    providerLine = providerLineFromSnapshot(acknowledged) ?? providerLine;
  }
  const disclosure = view.awaitingPayment
    ? buildPrepaymentDisclosure(view, forPage)
    : null;

  const feeLabel =
    view.sourceFee === 0
      ? 'FREE'
      : formatMoney(view.sourceFee, view.sourceCurrency);

  const successLine = (
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
  );
  // Fix pack 6 (P11): the receipt and its print hint, only when a receipt renders (b2b: none).
  const receiptBlock = receipt ? (
    <>
      <p className="mt-4 text-[13px] leading-normal text-[#8696a0] print:hidden">{PAY_RECEIPT_PRINT_HINT}</p>
      <PayReceipt receipt={receipt} transferId={view.id} />
    </>
  ) : null;
  // Fix pack 6 (P11): the non-awaiting sheet by state. Neutral copy only: a held row never
  // reads "sent" or "complete", and nothing says why.
  const doneBlock =
    receiptState === 'complete_receipt' ? (
      <>
        {successLine}
        {receiptBlock}
      </>
    ) : receiptState === 'held_receipt' ? (
      <>
        <p className={neutralClasses}>{FIXED_REPLIES.label_held}</p>
        {receiptBlock}
      </>
    ) : receiptState === 'held_no_receipt' ? (
      <p className={neutralClasses}>{FIXED_REPLIES.label_held}</p>
    ) : receiptState === 'not_completed' ? (
      <p className={neutralClasses}>{PAY_RECEIPT_NOT_COMPLETED_COPY}</p>
    ) : receiptState === 'refunded' ? (
      <p className={neutralClasses}>{PAY_RECEIPT_REFUNDED_COPY}</p>
    ) : (
      successLine
    );

  return (
    <main className={receipt ? receiptPageClasses : pageClasses}>
      <div className={receipt ? receiptSheetClasses : sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>Secure payment</h1>
        {providerLine && (
          <p data-testid="provider-line" className="-mt-3 mb-4 text-[13px] leading-normal text-[#8696a0]">
            {providerLine}
          </p>
        )}
        {view.awaitingPayment && view.preparedByNote && (
          <p data-prepared-by className="mb-4 rounded-xl border border-[#2a3942] p-3.5 text-sm leading-normal text-[#e9edef]">
            {view.preparedByNote}
          </p>
        )}
        <div className={receipt ? receiptSummaryClasses : summaryClasses}>
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
        {view.awaitingPayment && view.rewardNote && (
          <p data-reward-note className="mb-4 rounded-xl bg-[#202c33] p-3.5 text-sm font-semibold text-[#25d366]">
            {view.rewardNote}
          </p>
        )}
        {/* Fix pack 6 (P8): while E-SIGN consent is asked, the form renders the disclosure
            below the consent block (same place on the page); otherwise unchanged. */}
        {disclosure && !view.esignVersion && <RemittanceDisclosure disclosure={disclosure} />}
        {view.awaitingPayment ? (
          <PayForm
            disclosureVersion={disclosure?.version ?? null}
            disclosureHash={disclosure ? resolvedDisclosure.hash : null}
            approving={{
              amountText: approvingAmountText(view.sourceTotalCharge),
              currency: view.sourceCurrency,
              recipientName: view.recipientName,
              accountLast4: view.approvingLast4,
            }}
            legalNameRequired={view.legalNameRequired}
            legalNameOnFile={view.legalNameOnFile}
            originator={view.originator}
            {...(view.esignVersion
              ? {
                  esignVersion: view.esignVersion,
                  disclosureSlot: disclosure ? <RemittanceDisclosure disclosure={disclosure} /> : null,
                }
              : {})}
            {...(view.receiptOnReload ? { receiptOnReload: true } : {})}
            {...(view.riskWarning ? { riskWarning: true } : {})}
            transferId={view.id}
            destinationCountry={view.destinationCountry}
            needsBankDetails={view.needsBankDetails}
            savedAccountLabel={view.savedAccountLabel}
            bankDetailsLocked={view.bankDetailsLocked}
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
          doneBlock
        )}
      </div>
    </main>
  );
}
