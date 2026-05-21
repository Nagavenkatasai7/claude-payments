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

export default async function PayPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const { transferId } = await params;
  const transfer = await getStore().getTransfer(transferId);

  if (!transfer) {
    return (
      <main className="card">
        <div className="brand">SendHome</div>
        <h1>Transfer not found</h1>
      </main>
    );
  }

  return (
    <main className="card">
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
      </div>
      {transfer.status === 'awaiting_payment' ? (
        <PayForm transferId={transfer.id} />
      ) : (
        <p className="done">✅ Payment complete — money sent!</p>
      )}
    </main>
  );
}
