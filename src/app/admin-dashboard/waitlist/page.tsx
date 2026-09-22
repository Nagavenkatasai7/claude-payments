export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { WAITLIST_DESTINATIONS } from '@/app/landing/corridors';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// /admin-dashboard/waitlist — SmartRemit's OWN "Join waitlist" signups (the
// public landing form). Not tenant data: PLATFORM STAFF (admins and agents;
// the nav item is admin-only, but the nav is never the guard) may read the
// MASKED list; partner-scoped staff get a 404 (the page does not exist for
// them — never a 403 that confirms it does). The list is masked at the repo
// layer (initial · a***@domain · last-4) and never decrypts; the only
// decrypting path is the platform-ADMIN-only, audited CSV export
// (./export/route.ts).

const COLUMNS: ExpandableColumn[] = [
  { label: 'Name', primary: true },
  { label: 'Email', primary: true },
  { label: 'Phone' },
  { label: 'Destinations', primary: true },
  { label: 'Consent' },
  { label: 'Source' },
  { label: 'Joined', primary: true },
];

export default async function WaitlistPage() {
  const { staff, scope } = await requireScope();
  if (scope.kind !== 'platform') notFound();

  const repo = createWaitlistRepo(getDb());
  const [rows, counts] = await Promise.all([repo.listMasked(), repo.countsByDestination()]);
  const labelOf = (code: string) => WAITLIST_DESTINATIONS.find((c) => c.value === code)?.label ?? code;
  const countries = Object.entries(counts.byCountry).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <>
      <Sidebar active="waitlist" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Waitlist</div>
            <div className="sh-page-sub">
              {counts.total} signup{counts.total === 1 ? '' : 's'} · masked view
            </div>
          </div>
          {staff.role === 'admin' && (
            // A POST (never a GET with a side effect): the browser downloads the
            // attachment without leaving the page; the route checks same-origin.
            <form method="post" action="/admin-dashboard/waitlist/export">
              <button
                type="submit"
                className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary"
              >
                Export CSV (decrypted, audited)
              </button>
            </form>
          )}
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>By destination country</CardTitle>
            <CardDescription>A signup that picked several countries counts once in each.</CardDescription>
          </CardHeader>
          <CardContent>
            {countries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No signups yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {countries.map(([code, n]) => (
                  <li key={code}>
                    <Badge variant="outline">
                      {labelOf(code)} <span className="ml-1 font-semibold">{n}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signups</CardTitle>
            <CardDescription>
              Newest first. Names, emails, phones and locations are encrypted at rest; this list shows masks only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={COLUMNS}
              empty={<>No waitlist signups yet.</>}
              rows={rows.map((r) => ({
                key: r.id,
                label: r.emailMasked,
                cells: [
                  <span key="name" className="font-medium">{r.nameInitial}</span>,
                  <span key="email">{r.emailMasked}</span>,
                  <span key="phone" className="tabular-nums">****{r.phoneLast4}</span>,
                  <span key="dest" className="flex flex-wrap gap-1">
                    {r.destinations.map((c) => (
                      <Badge key={c} variant="outline">{c}</Badge>
                    ))}
                  </span>,
                  <span key="consent" className="whitespace-nowrap text-muted-foreground">
                    {r.consentTextVersion} · {new Date(r.consentAt).toLocaleDateString()}
                  </span>,
                  r.utmSource || r.utmCampaign ? (
                    <span key="src" className="text-muted-foreground">
                      {[r.utmSource, r.utmCampaign].filter(Boolean).join(' / ')}
                    </span>
                  ) : (
                    <span key="src" className="text-xs text-muted-foreground">—</span>
                  ),
                  <span key="joined" className="whitespace-nowrap text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>,
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
