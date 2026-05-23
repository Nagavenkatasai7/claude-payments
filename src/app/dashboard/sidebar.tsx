import { requireStaff } from '@/lib/auth';

export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'compliance'
  | 'team';

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';

  return (
    <aside className="sh-sidebar">
      <a
        href="/dashboard"
        className={`sh-nav-item ${active === 'overview' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◾</span> Overview
      </a>
      <a
        href="/dashboard/transactions"
        className={`sh-nav-item ${active === 'transactions' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↔</span> Transactions
      </a>
      <a
        href="/dashboard/schedules"
        className={`sh-nav-item ${active === 'schedules' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↻</span> Schedules
      </a>
      <a
        href="/dashboard/compliance"
        className={`sh-nav-item ${active === 'compliance' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">⚑</span> Compliance
      </a>
      {isAdmin && (
        <>
          <div className="sh-nav-label">Account</div>
          <a
            href="/dashboard/team"
            className={`sh-nav-item ${active === 'team' ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">◉</span> Team
          </a>
          <a href="/dashboard" className="sh-nav-item">
            <span className="sh-nav-icon">⚙</span> Settings
          </a>
        </>
      )}
    </aside>
  );
}
