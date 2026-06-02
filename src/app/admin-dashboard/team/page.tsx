export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuditLogStore } from '@/lib/audit-log-store';
import { requirePlatformAdmin } from '@/lib/auth';
import type { Partner, Staff } from '@/lib/types';
import { Sidebar } from '../sidebar';
import { Icon } from '../icons';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import {
  updateStaffAction,
  setStaffStatusAction,
  removeStaffAction,
} from './actions';

const STAFF_COLUMNS: ExpandableColumn[] = [
  { label: 'Member', primary: true },
  { label: 'Role', primary: true },
  { label: 'Scope' },
  { label: 'Status', primary: true },
  { label: 'Last active' },
  { label: 'Role & access' },
  { label: 'Actions' },
];

function shortDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  // date + HH:MM (UTC) so two same-day logins are distinguishable, matching the
  // audit row's granularity.
  return Number.isNaN(d.getTime()) ? '—' : iso.replace('T', ' ').slice(0, 16);
}

function PartnerOptions({ partners }: { partners: Partner[] }) {
  return (
    <>
      <option value="">Platform (no partner)</option>
      {partners.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
}

function staffRow(s: Staff, opts: { isSelf: boolean; partners: Partner[]; partnerName: (id?: string) => string }) {
  const status = s.status === 'suspended' ? 'suspended' : 'active';
  const initial = s.name.charAt(0).toUpperCase();

  return {
    key: s.username,
    label: s.name,
    cells: [
      <span key="m" className="sh-name-cell">
        <span className={`sh-name-avatar${status === 'suspended' ? ' sh-name-avatar--muted' : ''}`}>{initial}</span>
        <span>
          <span className="sh-recipient">
            {s.name}
            {opts.isSelf ? <span className="sh-you-tag">You</span> : null}
          </span>
          <span className="sh-recipient-sub">{s.username}</span>
        </span>
      </span>,
      <span key="r" className={`sh-pill ${s.role === 'admin' ? 'sh-pill-info' : 'sh-pill-neutral'}`}>
        <span className="sh-pill-dot" />
        {s.role}
      </span>,
      <span key="sc" className="sh-scope-chip">
        <Icon name={s.partnerId ? 'building' : 'shield'} />
        {opts.partnerName(s.partnerId)}
      </span>,
      <span key="st" className={`sh-pill ${status === 'active' ? 'sh-pill-success' : 'sh-pill-danger'}`}>
        <span className="sh-pill-dot" />
        {status}
      </span>,
      <span key="la" className="sh-num">{shortDate(s.lastLoginAt)}</span>,
      <form key="ed" action={updateStaffAction} className="sh-inline-form">
        <input type="hidden" name="username" value={s.username} />
        <select name="role" className="sh-inline-select" defaultValue={s.role} aria-label={`Role for ${s.name}`}>
          <option value="agent">agent</option>
          <option value="admin">admin</option>
        </select>
        <select
          name="partnerId"
          className="sh-inline-select"
          defaultValue={s.partnerId ?? ''}
          aria-label={`Scope for ${s.name}`}
        >
          <PartnerOptions partners={opts.partners} />
        </select>
        <label className="sh-perm">
          <input type="checkbox" name="canCancel" defaultChecked={s.permissions.canCancel} /> Cancel
        </label>
        <label className="sh-perm">
          <input type="checkbox" name="canResend" defaultChecked={s.permissions.canResend} /> Resend
        </label>
        <label className="sh-perm">
          <input type="checkbox" name="canAssign" defaultChecked={s.permissions.canAssign} /> Assign
        </label>
        <button type="submit" className="sh-mini-btn">Save</button>
      </form>,
      opts.isSelf ? (
        <span key="ac" className="sh-recipient-sub">—</span>
      ) : (
        <span key="ac" className="sh-inline-form">
          <form action={setStaffStatusAction}>
            <input type="hidden" name="username" value={s.username} />
            <input type="hidden" name="status" value={status === 'active' ? 'suspended' : 'active'} />
            <button type="submit" className="sh-mini-btn">
              {status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </form>
          <form action={removeStaffAction}>
            <input type="hidden" name="username" value={s.username} />
            <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
          </form>
        </span>
      ),
    ],
  };
}

export default async function TeamPage() {
  const me = await requirePlatformAdmin();
  const [allStaff, partners, audit] = await Promise.all([
    getAuthStore().listStaff(),
    getPartnerStore().listPartners(),
    getAuditLogStore().list(20),
  ]);

  const partnerName = (id?: string) =>
    !id ? 'Platform' : partners.find((p) => p.id === id)?.name ?? id;
  const platformAdmins = allStaff.filter(
    (s) => s.role === 'admin' && !s.partnerId && s.status !== 'suspended',
  ).length;

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Team</div>
            <div className="sh-page-sub">
              Manage who can access SmartRemit, their role, scope, and permissions
            </div>
          </div>
          <Link href="/admin-dashboard/team/new" className="sh-btn-primary">
            <Icon name="plus" />
            Add teammate
          </Link>
        </div>

        {platformAdmins <= 1 && (
          <div className="sh-banner sh-banner-warning" role="status">
            <span className="sh-banner-icon"><Icon name="warning" /></span>
            <span>
              <strong>Only one platform admin.</strong> Add a second platform admin so the account
              can always be managed if one is locked out.
            </span>
          </div>
        )}

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Members</div>
              <div className="sh-card-sub">
                {allStaff.length} member{allStaff.length === 1 ? '' : 's'} across platform and partners
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={STAFF_COLUMNS}
            rows={allStaff.map((s) =>
              staffRow(s, { isSelf: s.username === me.username, partners, partnerName }),
            )}
            empty={<>No teammates yet — add your first.</>}
          />
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recent activity</div>
              <div className="sh-card-sub">Audit trail of team changes</div>
            </div>
          </div>
          {audit.length === 0 ? (
            <div className="sh-empty">No team changes recorded yet.</div>
          ) : (
            <ul className="sh-audit">
              {audit.map((e, i) => (
                <li key={i} className="sh-audit-row">
                  <span className="sh-audit-when">{e.at.replace('T', ' ').slice(0, 16)}</span>
                  <span className="sh-audit-text">
                    <span className="sh-audit-actor">{e.actor}</span> {e.action}{' '}
                    <span className="sh-audit-actor">{e.target}</span>
                    {e.detail ? ` — ${e.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
