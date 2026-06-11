import { Badge } from '@/components/ui/badge';
import type { Customer } from '@/lib/types';

/** The minimal customer fields the KYC column needs (works server- + client-side). */
export type KycInfo = Pick<Customer, 'kycStatus' | 'kycReviewState' | 'watchlistHit' | 'pepHit'>;

const STATUS: Record<string, { cls: string; label: string }> = {
  verified: { cls: 'border-success/50 text-success', label: 'Verified' },
  grandfathered: { cls: 'border-success/50 text-success', label: 'Grandfathered' },
  rejected: { cls: 'border-destructive/50 text-destructive', label: 'Rejected' },
  pending: { cls: 'text-muted-foreground', label: 'Pending' },
  not_started: { cls: 'text-muted-foreground', label: 'Not started' },
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
      <Badge variant="outline" className="text-muted-foreground">—</Badge>
    );
  }
  const s = STATUS[kyc.kycStatus] ?? { cls: 'text-muted-foreground', label: kyc.kycStatus };
  const inReview = kyc.kycReviewState === 'pending_review' || kyc.kycReviewState === 'needs_review';
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="outline" className={s.cls}>
        {s.label}
      </Badge>
      {inReview && (
        <Badge variant="outline" className="border-primary/50 text-primary">
          In review
        </Badge>
      )}
      {kyc.watchlistHit && (
        <Badge variant="destructive">
          Watchlist
        </Badge>
      )}
      {kyc.pepHit && (
        <Badge variant="outline" className="border-warning/50 text-warning">
          PEP
        </Badge>
      )}
    </div>
  );
}
