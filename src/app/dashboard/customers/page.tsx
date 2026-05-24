export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import type { Customer, Tier } from '@/lib/types';

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

export default async function CustomersPage() {
  await requireStaff();
  const store = getStore();
  const customerStore = getCustomerStore(store);
  const [customers, transfers] = await Promise.all([
    customerStore.listCustomers(),
    store.listTransfers(),
  ]);
  const now = new Date();

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
  const rows = customers
    .map((c) => ({ c, life: lifetimeByPhone.get(c.senderPhone) ?? { count: 0, cents: 0 } }))
    .sort((a, b) => {
      const aAt = a.life.lastAt ?? a.c.createdAt;
      const bAt = b.life.lastAt ?? b.c.createdAt;
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
          <div className="sh-ledger-wrap">
            {rows.length === 0 ? (
              <div className="sh-empty">No customers yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Phone</th>
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
                          <Link href={`/dashboard/customers/${c.senderPhone}`}>
                            +{c.senderPhone}
                          </Link>
                        </td>
                        <td>{new Date(c.firstSeenAt).toLocaleDateString()}</td>
                        <td>
                          <span className={tierBadge(tier)}>
                            {tierLabel(tier, c, now)}
                          </span>
                        </td>
                        <td>{c.kycStatus}</td>
                        <td>
                          <div className="sh-amount">
                            ${(life.cents / 100).toFixed(2)}
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
