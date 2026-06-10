export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { WATCHLIST } from '@/lib/compliance';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { MaskedDestination } from '../masked-destination';
import {
  releaseTransferAction,
  rejectTransferAction,
} from '../actions';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Transfer } from '@/lib/types';

const REVIEW_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
  { label: 'Actions' },
];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
];

const CORRIDOR_COLUMNS: ExpandableColumn[] = [
  { label: 'Partner', primary: true },
  { label: 'Corridor', primary: true },
  { label: 'Large-amount (USD)' },
  { label: 'Velocity / day' },
  { label: 'Watchlist' },
];

const VELOCITY_COLUMNS: ExpandableColumn[] = [
  { label: 'Phone', primary: true },
  { label: 'Transfers today', primary: true },
  { label: '' },
];

// "Recipient gets" is denominated in the transfer's DESTINATION currency
// (amountInr holds the destination amount post-multi-currency). Fall back to
// INR for legacy rows written before destinationCurrency existed.
function recipientGets(t: Transfer): string {
  return money(t.amountInr, t.destinationCurrency ?? 'INR');
}

function transferCells(t: Transfer) {
  return [
    <div key="recipient">
      <div className="font-semibold">{t.recipientName}</div>
      <MaskedDestination
        transferId={t.id}
        payoutMethod={t.payoutMethod}
        payoutDestination={t.payoutDestination}
      />
    </div>,
    <div key="amount">
      <div className="font-semibold tabular-nums">{money(t.amountSource, t.sourceCurrency)}</div>
      {t.sourceCurrency !== 'USD' && (
        <div className="mt-0.5 text-xs text-muted-foreground">≈ {money(t.amountUsd, 'USD')}</div>
      )}
      <div className="mt-0.5 text-xs text-muted-foreground">{recipientGets(t)}</div>
    </div>,
    <span key="reasons" className="inline-flex flex-wrap items-center gap-1.5">
      {t.complianceReasons.length === 0 ? '—' : t.complianceReasons.map((r) =>
        r === 'edd_required'
          ? <Badge key={r} variant="outline" className="border-warning/50 text-warning">EDD required</Badge>
          : <span key={r}>{r}</span>,
      )}
    </span>,
    new Date(t.createdAt).toLocaleString(),
    <span key="sender" className="text-xs text-muted-foreground">{t.phone}</span>,
  ];
}

export default async function CompliancePage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  // Stage 5e scan fix: four indexed queries (status / compliance_status /
  // GROUP BY velocity), partner-scoped at the WHERE — no more loading the
  // whole ledger and filtering in JS per render.
  const { inReview, flagged, blocked, topVelocity: topVel } = await scoped.complianceViews();

  const partners = await scoped.listPartners();
  const corridorRows = partners.flatMap((p) =>
    (p.countries ?? [])
      .filter((c) => c !== 'IN')
      .map((country) => {
        const rules = resolveCorridorRules(p, country);
        return {
          partnerName: p.name ?? '',
          corridor: `${country} → IN`,
          largeAmountUsd: rules.largeAmountUsd,
          velocityLimit: rules.velocityLimit,
          watchlistSize: rules.baseWatchlist.length + rules.watchlistExtra.length,
          watchlistExtra: rules.watchlistExtra,
        };
      }),
  );
  corridorRows.sort((a, b) => (a.partnerName + a.corridor).localeCompare(b.partnerName + b.corridor));

  return (
    <>
      <Sidebar active="compliance" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Compliance</div>
            <div className="sh-page-sub">
              Flagged + blocked transfers · watchlist · velocity
            </div>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Needs review</CardTitle>
            <CardDescription>
              {inReview.length} {inReview.length === 1 ? 'transfer' : 'transfers'} — payment captured, pending staff decision
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={REVIEW_COLUMNS}
              empty={<>No transfers awaiting review.</>}
              rows={inReview.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: [
                  ...transferCells(t),
                  <div key="actions" className="flex flex-wrap gap-2">
                    <form action={releaseTransferAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <Button type="submit" size="sm">Release</Button>
                    </form>
                    <form action={rejectTransferAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <Button type="submit" size="sm" variant="outline" className="text-destructive">Reject</Button>
                    </form>
                  </div>,
                ],
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Flagged transfers</CardTitle>
            <CardDescription>
              {flagged.length} {flagged.length === 1 ? 'transfer' : 'transfers'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No flagged transfers.</>}
              rows={flagged.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: transferCells(t),
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Blocked transfers</CardTitle>
            <CardDescription>
              {blocked.length} {blocked.length === 1 ? 'transfer' : 'transfers'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No blocked transfers.</>}
              rows={blocked.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: transferCells(t),
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Watchlist</CardTitle>
            <CardDescription>
              Recipient names that hard-block a transfer (read-only)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {WATCHLIST.map((name) => (
              <Badge key={name} variant="destructive">{name}</Badge>
            ))}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Corridor rules</CardTitle>
            <CardDescription>
              Resolved compliance rules per corridor (read-only). Full rule-creation UI is deferred.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={CORRIDOR_COLUMNS}
              empty={<>No corridors configured.</>}
              rows={corridorRows.map((r) => ({
                key: r.partnerName + r.corridor,
                label: `${r.partnerName} ${r.corridor}`,
                cells: [
                  r.partnerName,
                  r.corridor,
                  // largeAmountUsd is a USD-equivalent threshold, not a source amount — always USD
                  <span key="large" className="font-semibold tabular-nums">{money(r.largeAmountUsd, 'USD')}</span>,
                  <span key="velocity" className="font-semibold tabular-nums">{r.velocityLimit}</span>,
                  <span key="watchlist">
                    {r.watchlistSize}
                    {r.watchlistExtra.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {r.watchlistExtra.map((name) => (
                          <Badge key={name} variant="destructive">{name}</Badge>
                        ))}
                      </div>
                    )}
                  </span>,
                ],
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Top velocity today</CardTitle>
            <CardDescription>
              Phones with the most transfers today
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={VELOCITY_COLUMNS}
              empty={<>No activity today yet.</>}
              rows={topVel.map(({ phone, count }) => ({
                key: phone,
                label: phone,
                cells: [
                  phone,
                  <span key="count" className="font-semibold tabular-nums">{count}</span>,
                  <Button key="link" asChild size="sm" variant="outline">
                    <a href={`/admin-dashboard/transactions?phone=${encodeURIComponent(phone)}`}>
                      View transfers
                    </a>
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
