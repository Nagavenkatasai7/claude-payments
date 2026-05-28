export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../sidebar';
import type { Partner } from '@/lib/types';

function statusBadge(p: Partner): string {
  return p.status === 'active'
    ? 'sh-tag sh-tag-partner-active'
    : 'sh-tag sh-tag-partner-suspended';
}

export default async function PartnersPage() {
  const staff = await requireStaff();
  if (staff.partnerId) {
    redirect(`/dashboard/partners/${staff.partnerId}`);
  }
  const isAdmin = staff.role === 'admin';

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const partnerStore = getPartnerStore();

  // Ensure the default partner exists so the list is never empty.
  await partnerStore.ensureDefaultPartner();

  const [partners, customers, transfers] = await Promise.all([
    partnerStore.listPartners(),
    customerStore.listCustomers(),
    store.listTransfers(),
  ]);

  // Aggregate counts by partnerId.
  const customerCountByPartner = new Map<string, number>();
  for (const c of customers) {
    customerCountByPartner.set(
      c.partnerId,
      (customerCountByPartner.get(c.partnerId) ?? 0) + 1,
    );
  }
  const transferCountByPartner = new Map<string, number>();
  for (const t of transfers) {
    transferCountByPartner.set(
      t.partnerId,
      (transferCountByPartner.get(t.partnerId) ?? 0) + 1,
    );
  }

  // Sort: default first, then alphabetical by name.
  const rows = [...partners].sort((a, b) => {
    if (a.id === 'default' && b.id !== 'default') return -1;
    if (b.id === 'default' && a.id !== 'default') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Partners</div>
            <div className="sh-page-sub">
              {partners.length} total · multi-tenant boundary
            </div>
          </div>
          {isAdmin && (
            <Link href="/dashboard/partners/new" className="sh-btn-primary">
              + New partner
            </Link>
          )}
        </div>
        <section className="sh-card">
          <div className="sh-ledger-wrap">
            {rows.length === 0 ? (
              <div className="sh-empty">No partners yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Countries</th>
                    <th>Status</th>
                    <th>Customers</th>
                    <th>Transfers</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/dashboard/partners/${p.id}`}>{p.name}</Link>
                      </td>
                      <td>{p.countries.join(', ')}</td>
                      <td>
                        <span className={statusBadge(p)}>{p.status}</span>
                      </td>
                      <td>{customerCountByPartner.get(p.id) ?? 0}</td>
                      <td>{transferCountByPartner.get(p.id) ?? 0}</td>
                      <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
