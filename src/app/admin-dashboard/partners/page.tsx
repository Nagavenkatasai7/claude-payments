export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import type { Partner } from '@/lib/types';

const PARTNER_COLUMNS: ExpandableColumn[] = [
  { label: 'Name', primary: true },
  { label: 'Countries' },
  { label: 'Status', primary: true },
  { label: 'Customers' },
  { label: 'Transfers', primary: true },
  { label: 'Created' },
];

function statusBadge(p: Partner): string {
  return p.status === 'active'
    ? 'sh-tag sh-tag-partner-active'
    : 'sh-tag sh-tag-partner-suspended';
}

export default async function PartnersPage() {
  const staff = await requireStaff();
  if (staff.partnerId) {
    redirect(`/admin-dashboard/partners/${staff.partnerId}`);
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
            <Link href="/admin-dashboard/partners/new" className="sh-btn-primary">
              + New partner
            </Link>
          )}
        </div>
        <section className="sh-card">
          <ExpandableTable
            columns={PARTNER_COLUMNS}
            empty={<>No partners yet.</>}
            rows={rows.map((p) => ({
              key: p.id,
              label: p.name,
              cells: [
                <Link key="name" href={`/admin-dashboard/partners/${p.id}`}>
                  {p.name}
                </Link>,
                p.countries.join(', '),
                <span key="status" className={statusBadge(p)}>
                  {p.status}
                </span>,
                customerCountByPartner.get(p.id) ?? 0,
                transferCountByPartner.get(p.id) ?? 0,
                new Date(p.createdAt).toLocaleDateString(),
              ],
            }))}
          />
        </section>
      </main>
    </>
  );
}
