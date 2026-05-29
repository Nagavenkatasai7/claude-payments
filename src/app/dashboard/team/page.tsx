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

function StaffRow({ staff }: { staff: Staff }) {
  if (staff.role === 'admin') {
    return (
      <tr>
        <td>{staff.name}</td>
        <td>{staff.username}</td>
        <td>
          <span className="sh-pill sh-pill-info">
            <span className="sh-pill-dot"></span>admin
          </span>
        </td>
        <td colSpan={2}>
          <span className="sh-recipient-sub">Full access (all permissions)</span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{staff.name}</td>
      <td>{staff.username}</td>
      <td>
        <span className="sh-pill sh-pill-neutral">
          <span className="sh-pill-dot"></span>agent
        </span>
      </td>
      <td>
        <form action={updatePermissionsAction} className="sh-inline-form">
          <input type="hidden" name="username" value={staff.username} />
          <PermissionCheckbox name="canCancel" label="Cancel/refund" checked={staff.permissions.canCancel} />
          <PermissionCheckbox name="canResend" label="Resend" checked={staff.permissions.canResend} />
          <PermissionCheckbox name="canAssign" label="Assign" checked={staff.permissions.canAssign} />
          <button type="submit" className="sh-mini-btn">Save</button>
        </form>
      </td>
      <td>
        <form action={removeStaffAction}>
          <input type="hidden" name="username" value={staff.username} />
          <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
        </form>
      </td>
    </tr>
  );
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
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => <StaffRow key={s.username} staff={s} />)}
              </tbody>
            </table>
          </div>
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
