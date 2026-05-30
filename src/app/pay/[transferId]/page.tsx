import { getStore } from '@/lib/store';
import { getDraftStore } from '@/lib/draft-store';
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

function formatFundingMethod(method: string): string {
  switch (method) {
    case 'credit_card':
      return 'Credit card';
    case 'debit_card':
      return 'Debit card';
    case 'bank_transfer':
      return 'Bank transfer';
    default:
      return method;
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
    amountInr: number;
    amountUsd: number;
    feeUsd: number;
    totalChargeUsd: number;
    fundingMethod: string;
    awaitingPayment: boolean;
  };

  let view: View | null = null;

  if (transfer) {
    view = {
      id: transfer.id,
      recipientName: transfer.recipientName,
      amountInr: transfer.amountInr,
      amountUsd: transfer.amountUsd,
      feeUsd: transfer.feeUsd,
      totalChargeUsd: transfer.totalChargeUsd,
      fundingMethod: transfer.fundingMethod,
      awaitingPayment: transfer.status === 'awaiting_payment',
    };
  } else {
    // Dual-lookup: treat the segment as a draftId
    const draft = await getDraftStore().getDraft(transferId);
    if (draft) {
      view = {
        id: transferId,
        recipientName: draft.recipient.name,
        amountInr: draft.quote.amountInr,
        amountUsd: draft.amountUsd,
        feeUsd: draft.quote.feeUsd,
        totalChargeUsd:
          draft.quote.totalChargeUsd ?? draft.amountUsd + draft.quote.feeUsd,
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

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SendHome</div>
        <h1>Secure payment</h1>
        <div className="summary">
          <Row label="Recipient" value={view.recipientName} />
          <Row
            label="They receive"
            value={`₹${view.amountInr.toLocaleString('en-IN')}`}
          />
          <Row label="Amount" value={`$${view.amountUsd.toFixed(2)}`} />
          <Row
            label="Fee"
            value={view.feeUsd === 0 ? 'FREE' : `$${view.feeUsd.toFixed(2)}`}
          />
          <Row
            label="Total charge"
            value={`$${view.totalChargeUsd.toFixed(2)}`}
            bold
          />
          <Row
            label="Paying with"
            value={formatFundingMethod(view.fundingMethod)}
          />
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
