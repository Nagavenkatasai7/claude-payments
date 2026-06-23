export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// /admin-dashboard/partner-requests — inbound "Partner with us" leads from the
// public landing form. These are business-development contacts (company name,
// email, phone) carried across no tenant boundary, so they're PLATFORM-ONLY —
// partner-scoped staff must never see another partner's pipeline (the nav hides
// it; the requireScope bounce below closes the direct URL).

const COLUMNS: ExpandableColumn[] = [
  { label: 'Company', primary: true },
  { label: 'Email', primary: true },
  { label: 'Phone' },
  { label: 'Corridors' },
  { label: 'Application', primary: true },
  { label: 'Comments' },
  { label: 'Submitted', primary: true },
];

export default async function PartnerRequestsPage() {
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');

  const requests = await getStore().listPartnerRequests();

  return (
    <>
      <Sidebar active="partner-requests" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Partner requests</div>
            <div className="sh-page-sub">
              {requests.length} inbound lead{requests.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Inbound leads</CardTitle>
            <CardDescription>
              Companies that submitted the &ldquo;Partner with us&rdquo; form, newest by capture time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={COLUMNS}
              empty={<>No partner requests yet.</>}
              rows={requests.map((r) => {
                const completed = r.applicationStatus === 'completed';
                return {
                key: r.id,
                label: r.companyName,
                cells: [
                  completed ? (
                    <Link
                      key="company"
                      href={`/admin-dashboard/partner-requests/${r.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.companyName}
                    </Link>
                  ) : (
                    <span key="company" className="font-medium">{r.companyName}</span>
                  ),
                  <a key="email" href={`mailto:${r.email}`} className="text-primary hover:underline">
                    {r.email}
                  </a>,
                  r.phone,
                  r.corridors.length > 0 ? (
                    <span key="corr" className="flex flex-wrap gap-1">
                      {r.corridors.map((c) => (
                        <Badge key={c} variant="outline">{c}</Badge>
                      ))}
                    </span>
                  ) : (
                    <span key="corr" className="text-xs text-muted-foreground">—</span>
                  ),
                  completed ? (
                    <span key="app" className="flex items-center gap-2">
                      <Badge variant="outline" className="border-success/50 text-success">Completed</Badge>
                      <Link
                        href={`/admin-dashboard/partner-requests/${r.id}`}
                        className="text-xs text-primary hover:underline"
                      >
                        View application
                      </Link>
                    </span>
                  ) : (
                    <Badge key="app" variant="outline" className="text-muted-foreground">Invited</Badge>
                  ),
                  r.comments ? (
                    <span key="comments" className="block max-w-xs break-words whitespace-pre-line text-muted-foreground">
                      {r.comments}
                    </span>
                  ) : (
                    <span key="comments" className="text-xs text-muted-foreground">—</span>
                  ),
                  <span key="submitted" className="whitespace-nowrap text-muted-foreground">
                    {new Date(r.capturedAt).toLocaleString()}
                  </span>,
                ],
                };
              })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
