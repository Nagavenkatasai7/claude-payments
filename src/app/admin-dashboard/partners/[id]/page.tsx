export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { Sidebar } from '../../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../../expandable-table';
import { IssueKeyButton } from '../issue-key-button';
import {
  setPartnerStatusAction,
  updatePartnerAction,
  createPartnerStaffAction,
  removePartnerStaffAction,
  saveWhatsappConfigAction,
  savePaymentConfigAction,
  revokeApiKeyAction,
} from '../actions';
import type { CountryCode, Partner } from '@/lib/types';

// Show a secret's status without ever rendering its value.
function configuredBadge(set: boolean) {
  return set ? (
    <span className="sh-pill sh-pill-success"><span className="sh-pill-dot"></span>configured</span>
  ) : (
    <span className="sh-pill sh-pill-neutral"><span className="sh-pill-dot"></span>not set</span>
  );
}

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'ID' },
  { label: 'Phone', primary: true },
  { label: 'Amount', primary: true },
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
  // Suspend/reactivate is platform governance (setPartnerStatusAction now requires
  // requirePlatformAdmin) — only show the toggle to platform admins so a
  // partner-admin viewing their own partner doesn't get a button that errors.
  const isPlatformAdmin = isAdmin && !staff.partnerId;
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

  // WL self-service config. getIntegrations decrypts secrets — we ONLY read
  // booleans from them (never render a secret value). API keys list is public-safe.
  const integrations = await getPartnerIntegrationsStore().getIntegrations(partner.id);
  const apiKeys = await getPartnerApiKeyStore().list(partner.id);

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
          {isPlatformAdmin && partner.id !== 'default' && (
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
              <form action={updatePartnerAction} className="sh-acct-form" style={{ marginTop: 16 }}>
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
                  placeholder="Brand name (internal, optional)"
                />
                <input
                  className="sh-input"
                  name="displayName"
                  defaultValue={partner.displayName ?? ''}
                  placeholder="Display name — the brand customers see (e.g. Acme Pay)"
                />
                <input
                  className="sh-input"
                  name="supportContact"
                  defaultValue={partner.supportContact ?? ''}
                  placeholder="Support contact (e.g. support@acme.com)"
                />
                <input
                  className="sh-input"
                  name="botPersona"
                  defaultValue={partner.botPersona ?? ''}
                  placeholder="Bot persona / tone (optional, e.g. warm and concise)"
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
                <fieldset className="sh-fieldset">
                  <legend>KYC handling</legend>
                  <div className="sh-field">
                    <label className="sh-field-label" htmlFor="p-kycmode">Who runs identity verification?</label>
                    <select
                      id="p-kycmode"
                      className="sh-select"
                      name="kycMode"
                      defaultValue={partner.kycMode ?? 'ours'}
                    >
                      <option value="ours">SmartRemit runs KYC (default)</option>
                      <option value="delegated">Partner runs KYC (delegated)</option>
                    </select>
                  </div>
                  <label className="sh-perm" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      name="requireKycBeforeSend"
                      defaultChecked={partner.requireKycBeforeSend === true}
                    />{' '}
                    Still block sends until verified (only applies when delegated)
                  </label>
                  <p className="sh-recipient-sub" style={{ marginTop: 6 }}>
                    Sanctions screening always runs, in both modes.
                  </p>
                </fieldset>
                <input
                  className="sh-input"
                  name="adminNote"
                  defaultValue={partner.adminNote ?? ''}
                  placeholder="Admin note (internal, optional)"
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
              className="sh-acct-form"
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

        {isAdmin && (
          <>
            {/* ── WhatsApp channel (BYO Meta number) ── */}
            <section className="sh-card">
              <div className="sh-card-head">
                <div>
                  <div className="sh-card-title">WhatsApp channel</div>
                  <div className="sh-card-sub">
                    Bring your own Meta WhatsApp Business number. Secrets are write-only —
                    leave a field blank to keep the stored value.
                  </div>
                </div>
              </div>
              <div className="sh-card-body">
                <dl className="sh-dl">
                  <dt>Access token</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.token))}</dd>
                  <dt>Verify token</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.verifyToken))}</dd>
                  <dt>App secret</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.appSecret))}</dd>
                </dl>
                <form action={saveWhatsappConfigAction} className="sh-acct-form" style={{ marginTop: 12 }}>
                  <input type="hidden" name="id" value={partner.id} />
                  <input
                    className="sh-input"
                    name="phoneNumberId"
                    defaultValue={integrations.whatsapp.phoneNumberId ?? ''}
                    placeholder="Phone number ID (from Meta — routes inbound messages)"
                  />
                  <input className="sh-input" name="token" type="password" autoComplete="off" placeholder="Access token (leave blank to keep)" />
                  <input className="sh-input" name="verifyToken" type="password" autoComplete="off" placeholder="Webhook verify token (leave blank to keep)" />
                  <input className="sh-input" name="appSecret" type="password" autoComplete="off" placeholder="App secret (leave blank to keep)" />
                  <button type="submit" className="sh-btn-primary">Save WhatsApp config</button>
                </form>
              </div>
            </section>

            {/* ── Settlement rail (partner-provided) ── */}
            <section className="sh-card">
              <div className="sh-card-head">
                <div>
                  <div className="sh-card-title">Settlement rail</div>
                  <div className="sh-card-sub">
                    You settle funds; we relay the signed instruction and mirror your status callback.
                    SmartRemit never holds funds.
                  </div>
                </div>
              </div>
              <div className="sh-card-body">
                <dl className="sh-dl">
                  <dt>Provider</dt><dd>{integrations.payment.providerType ?? 'mock (default)'}</dd>
                  <dt>Settlement endpoint</dt><dd>{configuredBadge(Boolean(integrations.payment.credentials?.settlementUrl))}</dd>
                  <dt>Signing secret</dt><dd>{configuredBadge(Boolean(integrations.payment.credentials?.signingSecret))}</dd>
                  <dt>Webhook secret</dt><dd>{configuredBadge(Boolean(integrations.payment.webhookSecret))}</dd>
                </dl>
                <form action={savePaymentConfigAction} className="sh-acct-form" style={{ marginTop: 12 }}>
                  <input type="hidden" name="id" value={partner.id} />
                  <div className="sh-field">
                    <label className="sh-field-label" htmlFor="p-provider">Settlement provider</label>
                    <select id="p-provider" className="sh-select" name="providerType" defaultValue={integrations.payment.providerType ?? 'mock'}>
                      <option value="mock">Mock (auto-deliver, for testing)</option>
                      <option value="simulator">Simulator (real webhook loop, demo)</option>
                      <option value="http">HTTP rail (your live settlement endpoint)</option>
                    </select>
                  </div>
                  <input className="sh-input" name="settlementUrl" type="password" autoComplete="off" placeholder="Settlement endpoint URL (leave blank to keep / auto for simulator)" />
                  <input className="sh-input" name="signingSecret" type="password" autoComplete="off" placeholder="Outbound signing secret (leave blank to keep)" />
                  <input className="sh-input" name="webhookSecret" type="password" autoComplete="off" placeholder="Inbound webhook secret (leave blank to keep)" />
                  <button type="submit" className="sh-btn-primary">Save settlement config</button>
                </form>
              </div>
            </section>

            {/* ── API keys ── */}
            <section className="sh-card">
              <div className="sh-card-head">
                <div>
                  <div className="sh-card-title">API keys</div>
                  <div className="sh-card-sub">
                    Connect your systems to the Partner API. Keys are shown once at issue and stored hashed.
                  </div>
                </div>
              </div>
              <div className="sh-card-body">
                {apiKeys.length === 0 ? (
                  <p className="sh-recipient-sub">No keys yet.</p>
                ) : (
                  <dl className="sh-dl">
                    {apiKeys.map((k) => (
                      <div key={k.keyId} style={{ display: 'contents' }}>
                        <dt>
                          <code>sr_live_…{k.last4}</code>
                        </dt>
                        <dd style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {k.revokedAt ? (
                            <span className="sh-pill sh-pill-danger"><span className="sh-pill-dot"></span>revoked</span>
                          ) : (
                            <span className="sh-pill sh-pill-success"><span className="sh-pill-dot"></span>active</span>
                          )}
                          <span className="sh-recipient-sub">issued {new Date(k.createdAt).toLocaleDateString()}</span>
                          {!k.revokedAt && (
                            <form action={revokeApiKeyAction.bind(null, partner.id)}>
                              <input type="hidden" name="keyId" value={k.keyId} />
                              <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Revoke</button>
                            </form>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                <IssueKeyButton partnerId={partner.id} />
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
