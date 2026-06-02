export const dynamic = 'force-dynamic';

import { getAuthStore } from '@/lib/auth-store';
import { requirePlatformAdmin } from '@/lib/auth';
import {
  addStaffAction,
  updatePermissionsAction,
  removeStaffAction,
} from './actions';
import type { Staff } from '@/lib/types';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';

const STAFF_COLUMNS: ExpandableColumn[] = [
  { label: 'Name', primary: true },
  { label: 'Username' },
  { label: 'Role', primary: true },
  { label: 'Permissions' },
  { label: 'Actions' },
];

function PermissionCheckbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="sh-perm">
      <input type="checkbox" name={name} defaultChecked={checked} /> {label}
    </label>
  );
}

function staffRow(staff: Staff) {
  if (staff.role === 'admin') {
    return {
      key: staff.username,
      label: staff.name,
      cells: [
        staff.name,
        staff.username,
        <span key="role" className="sh-pill sh-pill-info">
          <span className="sh-pill-dot"></span>admin
        </span>,
        <span key="perms" className="sh-recipient-sub">Full access (all permissions)</span>,
        <></>,
      ],
    };
  }
  return {
    key: staff.username,
    label: staff.name,
    cells: [
      staff.name,
      staff.username,
      <span key="role" className="sh-pill sh-pill-neutral">
        <span className="sh-pill-dot"></span>agent
      </span>,
      <form key="perms" action={updatePermissionsAction} className="sh-inline-form">
        <input type="hidden" name="username" value={staff.username} />
        <PermissionCheckbox name="canCancel" label="Cancel/refund" checked={staff.permissions.canCancel} />
        <PermissionCheckbox name="canResend" label="Resend" checked={staff.permissions.canResend} />
        <PermissionCheckbox name="canAssign" label="Assign" checked={staff.permissions.canAssign} />
        <button type="submit" className="sh-mini-btn">Save</button>
      </form>,
      <form key="actions" action={removeStaffAction}>
        <input type="hidden" name="username" value={staff.username} />
        <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
      </form>,
    ],
  };
}

export default async function TeamPage() {
  await requirePlatformAdmin();
  const allStaff = await getAuthStore().listStaff();
  const staff = allStaff.filter((s) => !s.partnerId);

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Team &amp; Permissions</div>
            <div className="sh-page-sub">Manage staff accounts and per-agent permissions</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Staff</div>
              <div className="sh-card-sub">{staff.length} member{staff.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          <ExpandableTable
            columns={STAFF_COLUMNS}
            rows={staff.map((s) => staffRow(s))}
            empty={<>No staff members yet.</>}
          />
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Add a team agent</div>
              <div className="sh-card-sub">Agents log in with their own credentials and the permissions you select</div>
            </div>
          </div>
          <form id="add-staff-form" action={addStaffAction} className="sh-add-staff-form">
            <input name="name" placeholder="Full name" required className="sh-input" />
            <input name="username" placeholder="Username" required className="sh-input" />
            <input name="password" type="password" placeholder="Password" required className="sh-input" />
          </form>
          <div className="sh-perm-row">
            <label className="sh-perm">
              <input type="checkbox" name="canCancel" form="add-staff-form" /> Cancel/refund
            </label>
            <label className="sh-perm">
              <input type="checkbox" name="canResend" form="add-staff-form" /> Resend link
            </label>
            <label className="sh-perm">
              <input type="checkbox" name="canAssign" form="add-staff-form" /> Assign
            </label>
          </div>
          <div style={{ padding: '0 20px 20px' }}>
            <button type="submit" form="add-staff-form" className="sh-btn-primary">
              Add agent
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
