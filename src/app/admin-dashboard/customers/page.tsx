export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
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
          <div className="sh-ledger-wrap">
            {rows.length === 0 ? (
              <div className="sh-empty">No customers yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Phone</th>
                    {scoped.scope.kind === 'platform' && <th>Partner</th>}
                    <th>Country</th>
                    <th>First seen</th>
                    <th>Tier</th>
                    <th>KYC</th>
                    <th>Lifetime sent</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ c, life }) => {
                    const tier = deriveTier(c, now);
                    return (
                      <tr key={c.senderPhone}>
                        <td>
                          <Link href={`/admin-dashboard/customers/${c.senderPhone}`}>
                            +{c.senderPhone}
                          </Link>
                        </td>
                        {scoped.scope.kind === 'platform' && (
                          <td>{partnerById[c.partnerId]?.name ?? c.partnerId}</td>
                        )}
                        <td>{c.senderCountry}</td>
                        <td>{new Date(c.firstSeenAt).toLocaleDateString()}</td>
                        <td>
                          <span className={tierBadge(tier)}>
                            {tierLabel(tier, c, now)}
                          </span>
                        </td>
                        <td>{c.kycStatus}</td>
                        <td>
                          {/* Lifetime sent is a USD-equivalent aggregate across all transfers — always USD */}
                          <div className="sh-amount">
                            ${(life.cents / 100).toFixed(2)} USD
                          </div>
                          <div className="sh-recipient-sub">
                            {life.count} {life.count === 1 ? 'transfer' : 'transfers'}
                          </div>
                        </td>
                        <td>
                          {life.lastAt ? (
                            new Date(life.lastAt).toLocaleString()
                          ) : (
                            <span className="sh-recipient-sub">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
