export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import type { Customer, Partner, Tier } from '@/lib/types';

function tierBadge(tier: Tier): string {
  if (tier === 'T0') return 'sh-tag sh-tag-tier-t0';
  if (tier === 'T1') return 'sh-tag sh-tag-tier-t1';
  return 'sh-tag sh-tag-tier-suspended';
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

  const t0Count = customers.filter((c) => deriveTier(c, now) === 'T0').length;
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
            <Link href="/admin-dashboard/customers/new" className="sh-btn-primary">
              + New customer
            </Link>
          )}
        </div>
        <section className="sh-card">
          {scoped.scope.kind === 'platform' && (
            <form
              method="get"
              style={{
                display: 'flex',
                gap: 10,
                padding: '16px 20px',
                borderBottom: '1px solid var(--sh-border)',
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--sh-text-secondary)',
                }}
              >
                Partner
                <select name="partner" defaultValue={partnerFilter} className="sh-input">
                  <option value="">All partners</option>
                  {Object.values(partnerById).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="sh-btn-secondary">Apply</button>
            </form>
          )}
          <ExpandableTable
            columns={columns}
            empty={<>No customers yet.</>}
            rows={rows.map(({ c, life }) => {
              const tier = deriveTier(c, now);
              return {
                key: c.senderPhone,
                label: `+${c.senderPhone}`,
                cells: [
                  <Link href={`/admin-dashboard/customers/${c.senderPhone}`} key="phone">
                    +{c.senderPhone}
                  </Link>,
                  ...(isPlatform
                    ? [<span key="partner">{partnerById[c.partnerId]?.name ?? c.partnerId}</span>]
                    : []),
                  c.senderCountry,
                  new Date(c.firstSeenAt).toLocaleDateString(),
                  <span className={tierBadge(tier)} key="tier">
                    {tierLabel(tier, c, now)}
                  </span>,
                  c.kycStatus,
                  <div key="life">
                    {/* Lifetime sent is a USD-equivalent aggregate across all transfers — always USD */}
                    <div className="sh-amount">${(life.cents / 100).toFixed(2)} USD</div>
                    <div className="sh-recipient-sub">
                      {life.count} {life.count === 1 ? 'transfer' : 'transfers'}
                    </div>
                  </div>,
                  life.lastAt ? (
                    new Date(life.lastAt).toLocaleString()
                  ) : (
                    <span className="sh-recipient-sub" key="last">—</span>
                  ),
                ],
              };
            })}
          />
        </section>
      </main>
    </>
  );
}
