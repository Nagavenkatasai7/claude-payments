export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { getFxRates } from '@/lib/rate';
import { rankCorridorDemand, type CorridorDemand } from '@/lib/corridor-demand';
import { narrateCorridorBrief } from '@/lib/corridor-brief-ai';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CountryCode } from '@/lib/types';

// /admin-dashboard/corridors — the launch RECOMMENDER (platform-only). The raw
// unsupported-destination lead list is aggregated by corridor-demand.ts (pure,
// deterministic, TDD'd) into a ranked table, then narrated by an AI expansion
// brief. Sender phone numbers are never surfaced — only counts/sums (the
// aggregator strips them by construction; this page also never reads them).

const DEMAND_COLUMNS: ExpandableColumn[] = [
  { label: '#', primary: true },
  { label: 'Destination', primary: true },
  { label: 'Leads', primary: true, align: 'right' },
  { label: 'Senders', align: 'right' },
  { label: 'Trend (7d vs prior)', align: 'right' },
  { label: 'USD demand', align: 'right' },
  { label: 'Status' },
];

function trendCell(d: CorridorDemand) {
  if (d.growthLeads == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const up = d.growthLeads > 0;
  const flat = d.growthLeads === 0;
  const pct = d.growthPct == null ? null : `${d.growthPct >= 0 ? '+' : ''}${Math.round(d.growthPct)}%`;
  const cls = flat ? 'text-muted-foreground' : up ? 'text-emerald-500' : 'text-red-500';
  return (
    <span className={`text-xs font-medium ${cls}`}>
      {up ? '+' : ''}
      {d.growthLeads}
      {pct ? ` (${pct})` : ''}
    </span>
  );
}

function usdCell(d: CorridorDemand) {
  if (d.total.pricedLeads === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span>
      ${Math.round(d.total.usdDemand).toLocaleString('en-US')}
      <span className="ml-1 text-xs text-muted-foreground">
        ({d.total.pricedLeads} priced)
      </span>
    </span>
  );
}

export default async function CorridorsPage() {
  // Corridor requests are PLATFORM-WIDE demand data carrying sender phone
  // numbers across every tenant — partner-scoped staff must never see it
  // (Stage 5e fix; the nav already hides it, this closes the direct URL).
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');

  const [requests, partners] = await Promise.all([
    getStore().listCorridorRequests(),
    getPartnerStore().listPartners(),
  ]);

  // The supported corridor set is the union of every partner's countries.
  const supported = Array.from(
    new Set(partners.flatMap((p) => p.countries)),
  ) as CountryCode[];

  const ranked = await rankCorridorDemand(requests, supported, getFxRates);

  // AI expansion brief over the top destinations — best-effort. A model outage
  // (or no demand at all) just hides the brief; the ranked table always renders.
  let brief: string | null = null;
  if (ranked.length > 0) {
    try {
      brief = await narrateCorridorBrief(ranked, 5);
    } catch {
      brief = null;
    }
  }

  const totalLeads = requests.length;

  return (
    <>
      <Sidebar active="corridors" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Corridor demand</div>
            <div className="sh-page-sub">
              Where customers want to send that we don&apos;t deliver to yet — ranked by demand.
            </div>
          </div>
        </div>

        {brief && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Launch recommendation</CardTitle>
              <CardDescription>AI-generated from the ranked demand below.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-[13px] leading-relaxed whitespace-pre-line text-foreground">
                {brief}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Ranked destinations</CardTitle>
            <CardDescription>
              {ranked.length} {ranked.length === 1 ? 'destination' : 'destinations'} ·{' '}
              {totalLeads} {totalLeads === 1 ? 'lead' : 'leads'} total
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={DEMAND_COLUMNS}
              empty={<>No corridor demand captured yet.</>}
              rows={ranked.map((d, i) => ({
                key: d.key,
                label: d.destination,
                cells: [
                  <span key="rank" className="text-xs text-muted-foreground">{i + 1}</span>,
                  d.destination,
                  <span key="leads" className="font-medium">{d.total.leads}</span>,
                  d.total.distinctSenders,
                  trendCell(d),
                  usdCell(d),
                  d.supported ? (
                    <Badge key="st" variant="secondary">Already supported</Badge>
                  ) : (
                    <Badge key="st" variant="outline">Unsupported</Badge>
                  ),
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
