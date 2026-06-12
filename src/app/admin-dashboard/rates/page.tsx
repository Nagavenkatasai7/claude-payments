export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { effectiveRateFor } from '@/lib/partner-rates';
import { getFxRates, type FxRates } from '@/lib/rate';
import type { CurrencyCode, PartnerRate } from '@/lib/types';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const RATE_COLUMNS: ExpandableColumn[] = [
  { label: 'Corridor', primary: true },
  { label: 'Partner', primary: true },
  { label: 'Pushed rate' },
  { label: 'Freshness', primary: true },
  { label: 'Margin (bps)' },
  { label: 'Mid (live)' },
  { label: 'Offering now' },
];

// src→dest mid, mirroring quote()'s cross-rate: INR destinations use the
// source's toInr directly; everything else pivots through USD.
function midFor(rate: PartnerRate, fx: Map<CurrencyCode, FxRates>): number | null {
  const src = fx.get(rate.sourceCurrency);
  if (!src) return null;
  if (rate.destinationCurrency === 'INR') {
    return Number.isFinite(src.toInr) && src.toInr > 0 ? src.toInr : null;
  }
  const dest = fx.get(rate.destinationCurrency);
  if (!Number.isFinite(src.toUsd) || src.toUsd <= 0) return null;
  if (!dest || !Number.isFinite(dest.toUsd) || dest.toUsd <= 0) return null;
  return src.toUsd / dest.toUsd;
}

// Mirrors effectiveRateFor's pushed-rate predicate (rate > 0 AND unexpired) so
// the badge never claims FRESH for a push the selector would refuse.
function freshnessBadge(r: PartnerRate, nowMs: number) {
  if (r.effectiveRate === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const fresh =
    r.effectiveRate > 0 && r.expiresAt !== undefined && Date.parse(r.expiresAt) > nowMs;
  return fresh ? (
    <Badge variant="outline" className="border-success/50 text-success">FRESH</Badge>
  ) : (
    <Badge variant="outline" className="text-destructive">EXPIRED</Badge>
  );
}

export default async function RatesPage() {
  // Partner rate sheets are CROSS-TENANT pricing intelligence — a partner-scoped
  // staffer must never see a rival's rates (their own live on their partner's
  // Pricing tab). Platform-only, same gate as /corridors: the nav hides it,
  // this closes the direct URL.
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');

  const [rates, partners] = await Promise.all([
    createPartnerRateRepo(getDb()).listAllRates(), // already ordered by corridor, then partner
    getPartnerStore().listPartners(),
  ]);
  const partnerName = new Map(partners.map((p) => [p.id, p.name]));

  // One live mid fetch per distinct currency involved (L1/L2-cached; fail-open
  // to built-in fallbacks) — fine on a force-dynamic admin page.
  const currencies = [...new Set(rates.flatMap((r) => [r.sourceCurrency, r.destinationCurrency]))];
  const fxEntries = await Promise.all(
    currencies.map(async (c) => [c, await getFxRates(c)] as const),
  );
  const fx = new Map<CurrencyCode, FxRates>(fxEntries);
  const now = new Date();
  const nowMs = now.getTime();

  return (
    <>
      <Sidebar active="rates" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Partner rates</div>
            <div className="sh-page-sub">
              Every partner&apos;s corridor pricing — pushed rates, margins, and what each
              would offer against the live mid-market rate right now.
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All rate records</CardTitle>
            <CardDescription>
              {rates.length} {rates.length === 1 ? 'record' : 'records'}, grouped by corridor.
              A partner wins a quote only by beating the mid for the customer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={RATE_COLUMNS}
              empty={<>No partner rates yet — partners push rates via the API; margins are set on each partner&apos;s Pricing tab.</>}
              rows={rates.map((r) => {
                const mid = midFor(r, fx);
                const offering = mid !== null ? effectiveRateFor(r, mid, now) : null;
                return {
                  key: r.id,
                  label: `${r.sourceCurrency} → ${r.destinationCurrency} · ${partnerName.get(r.partnerId) ?? r.partnerId}`,
                  cells: [
                    <span key="corridor" className="font-medium">{r.sourceCurrency} → {r.destinationCurrency}</span>,
                    partnerName.get(r.partnerId) ?? r.partnerId,
                    r.effectiveRate !== undefined ? (
                      <span key="pushed" className="tabular-nums">
                        {r.effectiveRate}
                        {r.expiresAt && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            exp {new Date(r.expiresAt).toLocaleString()}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span key="pushed" className="text-xs text-muted-foreground">—</span>
                    ),
                    freshnessBadge(r, nowMs),
                    r.marginBps !== undefined ? (
                      <span key="margin" className="tabular-nums">{r.marginBps}</span>
                    ) : (
                      <span key="margin" className="text-xs text-muted-foreground">—</span>
                    ),
                    mid !== null ? (
                      <span key="mid" className="tabular-nums">{mid.toFixed(4)}</span>
                    ) : (
                      <span key="mid" className="text-xs text-muted-foreground">—</span>
                    ),
                    offering !== null ? (
                      <span
                        key="offering"
                        className={`tabular-nums ${mid !== null && offering > mid ? 'text-success' : ''}`}
                      >
                        {offering.toFixed(4)}
                      </span>
                    ) : (
                      <span key="offering" className="text-xs text-muted-foreground">not competing</span>
                    ),
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
