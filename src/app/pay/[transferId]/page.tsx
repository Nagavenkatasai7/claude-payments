import { getStore } from '@/lib/store';
import { getDraftStore } from '@/lib/draft-store';
import type { CurrencyCode } from '@/lib/types';
import { PayForm } from './pay-form';

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
    <div className="row" style={bold ? { fontWeight: 700 } : undefined}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
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
  const transfer = await getStore().getTransfer(transferId);

  // ── Build a unified view object so JSX is shared between both paths ──

  type View = {
    id: string;
    recipientName: string;
    // Destination (recipient) side
    destAmount: number;
    destCurrency: string;
    // Source (sender) side
    sourceAmount: number;
    sourceFee: number;
    sourceTotalCharge: number;
    sourceCurrency: string;
    fundingMethod: string;
    awaitingPayment: boolean;
  };

  let view: View | null = null;

  if (transfer) {
    const destCurrency: string = transfer.destinationCurrency ?? 'INR';
    const sourceCurrency: string = transfer.sourceCurrency ?? 'USD';
    view = {
      id: transfer.id,
      recipientName: transfer.recipientName,
      destAmount: transfer.amountInr,
      destCurrency,
      sourceAmount: transfer.amountSource ?? transfer.amountUsd,
      sourceFee: transfer.feeSource ?? transfer.feeUsd,
      sourceTotalCharge: transfer.totalChargeSource ?? transfer.totalChargeUsd,
      sourceCurrency,
      fundingMethod: transfer.fundingMethod,
      awaitingPayment: transfer.status === 'awaiting_payment',
    };
  } else {
    // Dual-lookup: treat the segment as a draftId
    const draft = await getDraftStore().getDraft(transferId);
    if (draft) {
      const destCurrency: string = draft.quote.destinationCurrency ?? draft.destinationCurrency ?? 'INR';
      const sourceCurrency: string = draft.sourceCurrency ?? 'USD';
      const feeSource = draft.quote.feeSource ?? draft.quote.feeUsd;
      const totalChargeSource =
        draft.quote.totalChargeSource ??
        draft.quote.totalChargeUsd ??
        draft.amountSource + feeSource;
      view = {
        id: transferId,
        recipientName: draft.recipient.name,
        destAmount: draft.quote.amountInr,
        destCurrency,
        sourceAmount: draft.amountSource,
        sourceFee: feeSource,
        sourceTotalCharge: totalChargeSource,
        sourceCurrency,
        fundingMethod: draft.fundingMethod,
        awaitingPayment: true, // a draft is always awaiting payment
      };
    }
  }

  if (!view) {
    return (
      <main className="payapp">
        <div className="card">
          <div className="brand">SendHome</div>
          <h1>This link is no longer active</h1>
        </div>
      </main>
    );
  }

  const feeLabel =
    view.sourceFee === 0
      ? 'FREE'
      : formatMoney(view.sourceFee, view.sourceCurrency);

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SendHome</div>
        <h1>Secure payment</h1>
        <div className="summary">
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
          <Row label="Paying with" value="Bank transfer" />
        </div>
        {view.awaitingPayment ? (
          <PayForm transferId={view.id} fundingMethod={view.fundingMethod as import('@/lib/types').FundingMethod} />
        ) : (
          <p className="done">&#x2705; Payment complete &mdash; money sent!</p>
        )}
      </div>
    </main>
  );
}
