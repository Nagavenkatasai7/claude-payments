export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { deriveTier } from '@/lib/tier-rules';
import { sendGateActive } from '@/lib/kyc-gate';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { KycBadge } from '../kyc-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Customer, Partner, Tier } from '@/lib/types';

function tierVariant(tier: Tier): 'outline' | 'secondary' | 'destructive' {
  if (tier === 'T0') return 'outline';
  if (tier === 'T1') return 'secondary';
  return 'destructive';
}

function tierLabel(tier: Tier, c: Customer, now: Date): string {
  if (tier === 'T0') {
    const ageMs = now.getTime() - new Date(c.firstSeenAt).getTime();
    const day = Math.min(3, Math.floor(ageMs / 86400000) + 1);
    return `T0 · day ${day}/3`;
  }
  return tier;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string }>;
}) {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const [customers, transfers, partners] = await Promise.all([
    scoped.listCustomers(),
    scoped.listTransfers(),
    scoped.listPartners(),
  ]);
  const now = new Date();

  const partnerById: Record<string, Partner> = {};
  for (const p of partners) partnerById[p.id] = p;

  const params = await searchParams;
  const partnerFilter = String(params.partner ?? '');
  const filteredCustomers = partnerFilter
    ? customers.filter((c) => c.partnerId === partnerFilter)
    : customers;

  // Lifetime sent per phone
  const lifetimeByPhone = new Map<string, { count: number; cents: number; lastAt?: string }>();
  for (const t of transfers) {
    const entry = lifetimeByPhone.get(t.phone) ?? { count: 0, cents: 0 };
    entry.count++;
    entry.cents += Math.round(t.amountUsd * 100);
    if (!entry.lastAt || t.createdAt > entry.lastAt) entry.lastAt = t.createdAt;
    lifetimeByPhone.set(t.phone, entry);
  }

  // Sort: most-recently-active first
  const rows = filteredCustomers
    .map((c) => ({ c, life: lifetimeByPhone.get(c.senderPhone) ?? { count: 0, cents: 0 } }))
    .sort((a, b) => {
      // `?? ''` final fallback so a customer with neither a transfer nor a
      // populated createdAt sorts to the bottom rather than crashing the page.
      const aAt = a.life.lastAt ?? a.c.createdAt ?? '';
      const bAt = b.life.lastAt ?? b.c.createdAt ?? '';
      return bAt.localeCompare(aAt);
    });

  const t0Count = customers.filter((c) => deriveTier(c, now, sendGateActive(partnerById[c.partnerId])) === 'T0').length;
  const isAdmin = staff.role === 'admin';
  const isPlatform = scoped.scope.kind === 'platform';

  const columns: ExpandableColumn[] = [
    { label: 'Phone', primary: true },
    ...(isPlatform ? [{ label: 'Partner' }] : []),
    { label: 'Country' },
    { label: 'First seen' },
    { label: 'Tier', primary: true },
    { label: 'KYC' },
    { label: 'Lifetime sent', primary: true },
    { label: 'Last activity' },
  ];

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Customers</div>
            <div className="sh-page-sub">
              {customers.length} total · {t0Count} in observation window
            </div>
          </div>
          {isAdmin && (
            <Button asChild>
              <Link href="/admin-dashboard/customers/new">+ New customer</Link>
            </Button>
          )}
        </div>
        <Card>
          <CardContent className="space-y-4">
            {scoped.scope.kind === 'platform' && (
              <form method="get" className="flex flex-wrap items-center gap-2">
                <select
                  name="partner"
                  defaultValue={partnerFilter}
                  className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                  aria-label="Filter by partner"
                >
                  <option value="">All partners</option>
                  {Object.values(partnerById).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button type="submit" variant="outline">Apply</Button>
              </form>
            )}
            <ExpandableTable
              columns={columns}
              empty={<>No customers yet.</>}
              rows={rows.map(({ c, life }) => {
                const tier = deriveTier(c, now, sendGateActive(partnerById[c.partnerId]));
                return {
                  key: c.senderPhone,
                  label: `+${c.senderPhone}`,
                  cells: [
                    <Link
                      href={`/admin-dashboard/customers/${c.senderPhone}`}
                      className="text-primary underline-offset-2 hover:underline"
                      key="phone"
                    >
                      +{c.senderPhone}
                    </Link>,
                    ...(isPlatform
                      ? [<span key="partner">{partnerById[c.partnerId]?.name ?? c.partnerId}</span>]
                      : []),
                    c.senderCountry,
                    new Date(c.firstSeenAt).toLocaleDateString(),
                    <Badge variant={tierVariant(tier)} key="tier">
                      {tierLabel(tier, c, now)}
                    </Badge>,
                    <KycBadge kyc={c} key="kyc" />,
                    <div key="life">
                      {/* Lifetime sent is a USD-equivalent aggregate across all transfers — always USD */}
                      <div className="font-medium tabular-nums">${(life.cents / 100).toFixed(2)} USD</div>
                      <div className="text-xs text-muted-foreground">
                        {life.count} {life.count === 1 ? 'transfer' : 'transfers'}
                      </div>
                    </div>,
                    life.lastAt ? (
                      new Date(life.lastAt).toLocaleString()
                    ) : (
                      <span className="text-muted-foreground" key="last">—</span>
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
