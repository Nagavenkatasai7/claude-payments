export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getAuthStore } from '@/lib/auth-store';
import { Sidebar } from '../../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../../expandable-table';
import {
  setPartnerStatusAction,
  updatePartnerAction,
  createPartnerStaffAction,
  removePartnerStaffAction,
} from '../actions';
import type { CountryCode, Partner } from '@/lib/types';

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'ID' },
  { label: 'Phone', primary: true },
  { label: 'Amount', primary: true, align: 'right' },
  { label: 'Status', primary: true },
  { label: 'Created' },
];

const STAFF_COLUMNS: ExpandableColumn[] = [
  { label: 'Name', primary: true },
  { label: 'Username' },
  { label: 'Role', primary: true },
  { label: 'Created' },
  { label: 'Actions' },
];

function statusBadge(p: Partner): string {
  return p.status === 'active'
    ? 'sh-tag sh-tag-partner-active'
    : 'sh-tag sh-tag-partner-suspended';
}

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { staff } = await requireScope();
  const isAdmin = staff.role === 'admin';
  const { id } = await params;

  const scoped = createScopedStore(staff);
  const partner = await scoped.getPartner(id);
  if (!partner) notFound();

  const transfers = await scoped.listTransfers();
  const mine = transfers
    .filter((t) => t.partnerId === id)
    // `?? ''` defends against legacy transfers missing createdAt — see
    // store.listTransfers for the canonical pattern.
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const lifetimeCents = mine.reduce(
    (sum, t) => sum + Math.round(t.amountUsd * 100),
    0,
  );

  const allStaff = await getAuthStore().listStaff();
  const partnerStaff = allStaff.filter((s) => s.partnerId === partner.id);

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{partner.name}</div>
            <div className="sh-page-sub">
              Partner · {partner.id} · created {new Date(partner.createdAt).toLocaleDateString()}
            </div>
          </div>
          {isAdmin && partner.id !== 'default' && (
            <form action={setPartnerStatusAction} className="sh-inline-form">
              <input type="hidden" name="id" value={partner.id} />
              <input
                type="hidden"
                name="status"
                value={partner.status === 'active' ? 'suspended' : 'active'}
              />
              <button
                type="submit"
                className={
                  partner.status === 'active' ? 'sh-btn-secondary' : 'sh-btn-primary'
                }
              >
                {partner.status === 'active' ? 'Suspend' : 'Reactivate'}
              </button>
            </form>
          )}
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Identity</div>
              <div className="sh-card-sub">Partner record &amp; whitelabel placeholders</div>
            </div>
          </div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>ID</dt><dd>{partner.id}</dd>
              <dt>Name</dt><dd>{partner.name}</dd>
              <dt>Countries</dt><dd>{partner.countries.join(', ')}</dd>
              <dt>Status</dt>
              <dd>
                <span className={statusBadge(partner)}>{partner.status}</span>
              </dd>
              <dt>Brand name</dt><dd>{partner.brandName ?? '—'}</dd>
              <dt>Primary color</dt>
              <dd>
                {partner.primaryColor ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: partner.primaryColor,
                        border: '1px solid var(--sh-border)',
                      }}
                    />
                    {partner.primaryColor}
                  </span>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Logo URL</dt><dd>{partner.logoUrl ?? '—'}</dd>
              <dt>Admin note</dt><dd>{partner.adminNote ?? '—'}</dd>
              <dt>Created</dt><dd>{new Date(partner.createdAt).toLocaleString()}</dd>
              <dt>Updated</dt><dd>{new Date(partner.updatedAt).toLocaleString()}</dd>
            </dl>

            {isAdmin && (
              <form action={updatePartnerAction} className="sh-form" style={{ marginTop: 16 }}>
                <input type="hidden" name="id" value={partner.id} />
                <input
                  className="sh-input"
                  name="name"
                  defaultValue={partner.name}
                  placeholder="Partner name"
                  required
                />
                <fieldset className="sh-fieldset">
                  <legend>Operating countries</legend>
                  <div className="sh-perm-row">
                    {ALL_COUNTRIES.map((c) => (
                      <label className="sh-perm" key={c}>
                        <input
                          type="checkbox"
                          name="countries"
                          value={c}
                          defaultChecked={partner.countries.includes(c)}
                        />{' '}
                        {c}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <input
                  className="sh-input"
                  name="brandName"
                  defaultValue={partner.brandName ?? ''}
                  placeholder="Brand name (optional)"
                />
                <input
                  className="sh-input"
                  name="primaryColor"
                  type="color"
                  defaultValue={partner.primaryColor ?? '#1a73e8'}
                />
                <input
                  className="sh-input"
                  name="logoUrl"
                  defaultValue={partner.logoUrl ?? ''}
                  placeholder="Logo URL (optional)"
                />
                <input
                  className="sh-input"
                  name="adminNote"
                  defaultValue={partner.adminNote ?? ''}
                  placeholder="Admin note (optional)"
                />
                <button type="submit" className="sh-btn-primary">Save changes</button>
              </form>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Activity</div>
              <div className="sh-card-sub">Lifetime totals for this partner</div>
            </div>
          </div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>Transfers</dt><dd>{mine.length}</dd>
              <dt>Lifetime volume</dt><dd>${(lifetimeCents / 100).toFixed(2)}</dd>
            </dl>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recent transfers</div>
              <div className="sh-card-sub">
                {mine.length} {mine.length === 1 ? 'transfer' : 'transfers'} on file
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={TRANSFER_COLUMNS}
            empty={<>No transfers yet.</>}
            rows={mine.slice(0, 50).map((t) => ({
              key: t.id,
              label: t.id,
              cells: [
                t.id,
                `+${t.phone}`,
                <div key="amount" className="sh-amount">
                  ${t.amountUsd.toFixed(2)}
                </div>,
                t.status,
                new Date(t.createdAt).toLocaleString(),
              ],
            }))}
          />
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Staff for this partner</div>
              <div className="sh-card-sub">
                {partnerStaff.length} {partnerStaff.length === 1 ? 'member' : 'members'}
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={STAFF_COLUMNS}
            empty={<>No staff yet.</>}
            rows={partnerStaff.map((s) => ({
              key: s.username,
              label: s.name,
              cells: [
                s.name,
                s.username,
                <span
                  key="role"
                  className={`sh-pill ${s.role === 'admin' ? 'sh-pill-info' : 'sh-pill-neutral'}`}
                >
                  <span className="sh-pill-dot"></span>{s.role}
                </span>,
                new Date(s.createdAt).toLocaleDateString(),
                isAdmin ? (
                  <form key="actions" action={removePartnerStaffAction}>
                    <input type="hidden" name="username" value={s.username} />
                    <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
                  </form>
                ) : null,
              ],
            }))}
          />

          {isAdmin && (
            <form
              action={createPartnerStaffAction.bind(null, partner.id)}
              className="sh-form"
            >
              <input className="sh-input" name="username" placeholder="Username" required />
              <input className="sh-input" name="name" placeholder="Full name" required />
              <input className="sh-input" name="password" type="password" placeholder="Password" required />
              <select className="sh-input" name="role" defaultValue="agent">
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" className="sh-btn-primary">Invite staff</button>
            </form>
          )}
        </section>
      </main>
    </>
  );
}
