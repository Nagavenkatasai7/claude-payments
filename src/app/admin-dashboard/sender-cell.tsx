import { CustomerLink } from './customer-link';
import type { FundingMethod } from '@/lib/types';

// sender-cell — the ONE place "who is sending" renders across every staff transfer
// view, so the transactions list, compliance, ops, refunds, partner detail, and
// the dashboard all show the sender identically. Name (decrypted, via
// resolveSenderNames) when present, else just the phone; both link to the
// customer profile for full KYC + history. FundingRefs answers "which account to
// refund" — the system is non-custodial (no stored sender account), so we show
// the funding method + the provider's charge/refund references, which is the
// actual trail ops use to trigger/track a refund.

/** Sender identity for a transfer row: name (if KYC-captured) + phone, linked to the profile. */
export function SenderCell({ name, phone, partnerId }: { name?: string; phone: string; partnerId?: string }) {
  // The detail page is per (tenant, phone) since fix 1 — carry the row's tenant.
  // Program-Fix 37: a POST link (CustomerLink), so the phone never enters a URL.
  if (!name) {
    return (
      <CustomerLink phone={phone} partnerId={partnerId}>
        +{phone}
      </CustomerLink>
    );
  }
  return (
    <div className="leading-tight">
      <CustomerLink
        phone={phone}
        partnerId={partnerId}
        className="cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-foreground hover:underline"
      >
        {name}
      </CustomerLink>
      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">+{phone}</div>
    </div>
  );
}

const FUNDING_LABEL: Record<FundingMethod, string> = {
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  bank_transfer: 'Bank transfer',
  ach_pull: 'ACH bank debit',
  bank_pull: 'Bank debit',
};

/** "Which account to refund" — funding method + the provider charge/refund refs. */
export function FundingRefs({
  fundingMethod,
  fundingRef,
  refundRef,
}: {
  fundingMethod: FundingMethod;
  fundingRef?: string;
  refundRef?: string;
}) {
  return (
    <div className="text-xs leading-relaxed text-muted-foreground">
      <div>Paid via {FUNDING_LABEL[fundingMethod] ?? fundingMethod}</div>
      {fundingRef && <div className="tabular-nums">charge · {fundingRef}</div>}
      {refundRef && <div className="tabular-nums">refund · {refundRef}</div>}
    </div>
  );
}
