export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getAuthStore } from '@/lib/auth-store';
import { Sidebar } from '../../sidebar';
import {
  setPartnerStatusAction,
  updatePartnerAction,
  createPartnerStaffAction,
  removePartnerStaffAction,
} from '../actions';
import type { CountryCode, Partner } from '@/lib/types';

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

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
              <form action={updatePartnerAction} className="sh-inline-form" style={{ marginTop: 16, flexDirection: 'column', alignItems: 'stretch' }}>
                <input type="hidden" name="id" value={partner.id} />
                <input
                  className="sh-input"
                  name="name"
                  defaultValue={partner.name}
                  placeholder="Partner name"
                  required
                />
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
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Phone</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {mine.length === 0 && (
                  <tr>
                    <td colSpan={5} className="sh-empty">No transfers yet.</td>
                  </tr>
                )}
                {mine.slice(0, 50).map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>+{t.phone}</td>
                    <td>
                      <div className="sh-amount">${t.amountUsd.toFixed(2)}</div>
                    </td>
                    <td>{t.status}</td>
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr><th>Name</th><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {partnerStaff.length === 0 && (
                  <tr><td colSpan={5} className="sh-empty">No staff yet.</td></tr>
                )}
                {partnerStaff.map((s) => (
                  <tr key={s.username}>
                    <td>{s.name}</td>
                    <td>{s.username}</td>
                    <td>
                      <span className={`sh-pill ${s.role === 'admin' ? 'sh-pill-info' : 'sh-pill-neutral'}`}>
                        <span className="sh-pill-dot"></span>{s.role}
                      </span>
                    </td>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td>
                      {isAdmin && (
                        <form action={removePartnerStaffAction}>
                          <input type="hidden" name="username" value={s.username} />
                          <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isAdmin && (
            <form
              action={createPartnerStaffAction.bind(null, partner.id)}
              className="sh-inline-form"
              style={{ flexDirection: 'column', alignItems: 'stretch', padding: 20, gap: 8 }}
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
