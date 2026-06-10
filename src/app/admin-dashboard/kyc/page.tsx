export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getStore } from '@/lib/store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { Sidebar } from '../sidebar';
import { ExpandableTable } from '../expandable-table';
import { KycBadge } from '../kyc-badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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

  const tiles: {
    label: string;
    value: number;
    variant: 'secondary' | 'outline' | 'destructive';
    badgeClass?: string;
  }[] = [
    { label: 'In review', value: counts.in_review, variant: 'secondary' },
    { label: 'Verified', value: counts.verified, variant: 'outline', badgeClass: 'border-success/50 text-success' },
    { label: 'Grandfathered', value: counts.grandfathered, variant: 'outline', badgeClass: 'border-success/50 text-success' },
    { label: 'Pending', value: counts.pending, variant: 'outline' },
    { label: 'Not started', value: counts.not_started, variant: 'outline' },
    { label: 'Rejected', value: counts.rejected, variant: 'destructive' },
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

        <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => (
            <Card key={t.label}>
              <CardHeader className="pb-2">
                <CardDescription>
                  <Badge variant={t.variant} className={t.badgeClass}>{t.label}</Badge>
                </CardDescription>
                <CardTitle className="text-3xl tabular-nums">{t.value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </section>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Needs KYC review</CardTitle>
            <CardDescription>
              {needsKyc.length} {needsKyc.length === 1 ? 'customer' : 'customers'} — identity verification awaiting a human decision
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={[{ label: 'Phone', primary: true }, { label: 'KYC', primary: true }, { label: '' }]}
              empty={<>No customers awaiting KYC review.</>}
              rows={needsKyc.map((c) => ({
                key: c.senderPhone,
                label: `+${c.senderPhone}`,
                cells: [
                  <span key="phone">+{c.senderPhone}</span>,
                  <KycBadge key="kyc" kyc={c} />,
                  <Button key="open" asChild size="sm" variant="outline">
                    <a href={`/admin-dashboard/customers/${c.senderPhone}`}>Review</a>
                  </Button>,
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
