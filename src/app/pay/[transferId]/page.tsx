import { getStore } from '@/lib/store';
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

  if (!transfer) {
    return (
      <main className="payapp">
        <div className="card">
          <div className="brand">SendHome</div>
          <h1>Transfer not found</h1>
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
          <Row label="Recipient" value={transfer.recipientName} />
          <Row
            label="They receive"
            value={`₹${transfer.amountInr.toLocaleString('en-IN')}`}
          />
          <Row label="Amount" value={`$${transfer.amountUsd.toFixed(2)}`} />
          <Row
            label="Fee"
            value={
              transfer.feeUsd === 0 ? 'FREE' : `$${transfer.feeUsd.toFixed(2)}`
            }
          />
          <Row
            label="Total charge"
            value={`$${transfer.totalChargeUsd.toFixed(2)}`}
            bold
          />
          <Row
            label="Paying with"
            value={formatFundingMethod(transfer.fundingMethod)}
          />
        </div>
        {transfer.status === 'awaiting_payment' ? (
          <PayForm transferId={transfer.id} fundingMethod={transfer.fundingMethod} />
        ) : (
          <p className="done">&#x2705; Payment complete &mdash; money sent!</p>
        )}
      </div>
    </main>
  );
}
