import type { Customer } from '@/lib/types';

/** The minimal customer fields the KYC column needs (works server- + client-side). */
export type KycInfo = Pick<Customer, 'kycStatus' | 'kycReviewState' | 'watchlistHit' | 'pepHit'>;

const STATUS: Record<string, { cls: string; label: string }> = {
  verified: { cls: 'sh-pill-success', label: 'Verified' },
  grandfathered: { cls: 'sh-pill-success', label: 'Grandfathered' },
  rejected: { cls: 'sh-pill-danger', label: 'Rejected' },
  pending: { cls: 'sh-pill-neutral', label: 'Pending' },
  not_started: { cls: 'sh-pill-neutral', label: 'Not started' },
};

/**
 * Renders a customer's KYC status as a colored pill, plus secondary badges:
 *  - "In review" when a Persona case awaits a human (pending_review / needs_review),
 *  - "Watchlist" / "PEP" when a sanctions/PEP report matched.
 * Pure presentational — no hooks, no server-only deps — so it renders in the
 * server-rendered Customers list AND the client-side Transactions table.
 */
export function KycBadge({ kyc }: { kyc: KycInfo | undefined }) {
  if (!kyc) {
    return (
      <span className="sh-pill sh-pill-neutral">
        <span className="sh-pill-dot" />—
      </span>
    );
  }
  const s = STATUS[kyc.kycStatus] ?? { cls: 'sh-pill-neutral', label: kyc.kycStatus };
  const inReview = kyc.kycReviewState === 'pending_review' || kyc.kycReviewState === 'needs_review';
  return (
    <div className="sh-kyc-cell">
      <span className={`sh-pill ${s.cls}`}>
        <span className="sh-pill-dot" />
        {s.label}
      </span>
      {inReview && (
        <span className="sh-pill sh-pill-info">
          <span className="sh-pill-dot" />
          In review
        </span>
      )}
      {kyc.watchlistHit && (
        <span className="sh-pill sh-pill-danger">
          <span className="sh-pill-dot" />
          Watchlist
        </span>
      )}
      {kyc.pepHit && (
        <span className="sh-pill sh-pill-warning">
          <span className="sh-pill-dot" />
          PEP
        </span>
      )}
    </div>
  );
}
