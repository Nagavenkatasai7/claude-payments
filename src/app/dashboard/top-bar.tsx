import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';
import { LiveRefresh } from './live-refresh';

export async function TopBar() {
  const staff = await requireStaff();
  const initial = staff.name.charAt(0).toUpperCase();
  return (
    <header className="sh-topbar">
      <div className="sh-brand">
        <div className="sh-brand-mark">SH</div>
        SendHome
      </div>
      <div className="sh-search" aria-hidden="true">
        🔍 &nbsp;Search transactions, recipients, schedules…
      </div>
      <div className="sh-top-right">
        <LiveRefresh />
        <div className="sh-user">
          <div className="sh-avatar">{initial}</div>
          <span>{staff.name}</span>
        </div>
        <form action={logout}>
          <button type="submit" className="sh-btn-secondary">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
