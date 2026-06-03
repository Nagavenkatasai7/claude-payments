export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getStore } from '@/lib/store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { Sidebar } from '../sidebar';
import { ExpandableTable } from '../expandable-table';
import { KycBadge } from '../kyc-badge';

/**
 * Dedicated KYC surface (own sidebar entry). Two cards: a scoped status overview
 * (counts) and the human-review queue (customers in pending_review/needs_review),
 * each linking to the customer detail page where Approve/Reject lives. The review
 * queue used to live on /compliance; it now has its own home.
 */
export default async function KycPage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const customers = await scoped.listCustomers();
  const needsKyc = (await getKycCaseStore(getStore()).listNeedsReview()).filter((c) =>
    canSee(scopeOf(staff), c.partnerId),
  );

  const counts = { in_review: 0, verified: 0, grandfathered: 0, pending: 0, not_started: 0, rejected: 0 };
  for (const c of customers) {
    if (c.kycReviewState === 'pending_review' || c.kycReviewState === 'needs_review') counts.in_review++;
    if (c.kycStatus in counts) counts[c.kycStatus as 'verified' | 'grandfathered' | 'pending' | 'not_started' | 'rejected']++;
  }

  const tiles: { label: string; value: number; cls: string }[] = [
    { label: 'In review', value: counts.in_review, cls: 'sh-pill-info' },
    { label: 'Verified', value: counts.verified, cls: 'sh-pill-success' },
    { label: 'Grandfathered', value: counts.grandfathered, cls: 'sh-pill-success' },
    { label: 'Pending', value: counts.pending, cls: 'sh-pill-neutral' },
    { label: 'Not started', value: counts.not_started, cls: 'sh-pill-neutral' },
    { label: 'Rejected', value: counts.rejected, cls: 'sh-pill-danger' },
  ];

  return (
    <>
      <Sidebar active="kyc" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">KYC</div>
            <div className="sh-page-sub">Identity verification — review queue &amp; status</div>
          </div>
        </div>

        <section className="sh-metrics">
          {tiles.map((t) => (
            <div className="sh-metric" key={t.label}>
              <div className="sh-metric-label">
                <span className={`sh-pill ${t.cls}`}><span className="sh-pill-dot" />{t.label}</span>
              </div>
              <div className="sh-metric-value">{t.value}</div>
            </div>
          ))}
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Needs KYC review</div>
              <div className="sh-card-sub">
                {needsKyc.length} {needsKyc.length === 1 ? 'customer' : 'customers'} — identity verification awaiting a human decision
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={[{ label: 'Phone', primary: true }, { label: 'KYC', primary: true }, { label: '' }]}
            empty={<>No customers awaiting KYC review.</>}
            rows={needsKyc.map((c) => ({
              key: c.senderPhone,
              label: `+${c.senderPhone}`,
              cells: [
                <span key="phone">+{c.senderPhone}</span>,
                <KycBadge key="kyc" kyc={c} />,
                <a key="open" className="sh-mini-btn" href={`/admin-dashboard/customers/${c.senderPhone}`}>
                  Review
                </a>,
              ],
            }))}
          />
        </section>
      </main>
    </>
  );
}
