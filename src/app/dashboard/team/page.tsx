export const dynamic = 'force-dynamic';

import { getAuthStore } from '@/lib/auth-store';
import { requireAdmin } from '@/lib/auth';
import {
  addStaffAction,
  updatePermissionsAction,
  removeStaffAction,
} from './actions';
import type { Staff } from '@/lib/types';

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
    <label className="perm">
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
        <td>admin</td>
        <td colSpan={2}>Full access (all permissions)</td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{staff.name}</td>
      <td>{staff.username}</td>
      <td>agent</td>
      <td>
        <form action={updatePermissionsAction} className="perm-form">
          <input type="hidden" name="username" value={staff.username} />
          <PermissionCheckbox
            name="canCancel"
            label="Cancel/refund"
            checked={staff.permissions.canCancel}
          />
          <PermissionCheckbox
            name="canResend"
            label="Resend link"
            checked={staff.permissions.canResend}
          />
          <PermissionCheckbox
            name="canAssign"
            label="Assign"
            checked={staff.permissions.canAssign}
          />
          <button type="submit" className="action-btn">
            Save
          </button>
        </form>
      </td>
      <td>
        <form action={removeStaffAction}>
          <input type="hidden" name="username" value={staff.username} />
          <button type="submit" className="action-btn cancel-btn">
            Remove
          </button>
        </form>
      </td>
    </tr>
  );
}

export default async function TeamPage() {
  await requireAdmin();
  const staff = await getAuthStore().listStaff();

  return (
    <main className="dashboard">
      <header className="dash-header">
        <h1 className="dashboard-title">Team &amp; Permissions</h1>
        <a href="/dashboard" className="action-btn">
          ← Back to dashboard
        </a>
      </header>

      <section className="ledger-section">
        <h2>Staff</h2>
        <div className="ledger-wrapper">
          <table className="ledger">
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
              {staff.map((s) => (
                <StaffRow key={s.username} staff={s} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="attention">
        <h2>Add a team agent</h2>
        <form action={addStaffAction} className="add-staff-form">
          <input name="name" placeholder="Full name" required />
          <input name="username" placeholder="Username" required />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
          />
          <div className="perm-row">
            <PermissionCheckbox
              name="canCancel"
              label="Cancel/refund"
              checked={false}
            />
            <PermissionCheckbox
              name="canResend"
              label="Resend link"
              checked={false}
            />
            <PermissionCheckbox
              name="canAssign"
              label="Assign"
              checked={false}
            />
          </div>
          <button type="submit" className="action-btn assign-btn">
            Add agent
          </button>
        </form>
      </section>
    </main>
  );
}
