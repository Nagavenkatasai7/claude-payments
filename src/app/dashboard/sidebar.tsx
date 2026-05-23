import Link from 'next/link';
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
      <Link
        href="/dashboard"
        className={`sh-nav-item ${active === 'overview' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◾</span> Overview
      </Link>
      <Link
        href="/dashboard/transactions"
        className={`sh-nav-item ${active === 'transactions' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↔</span> Transactions
      </Link>
      <Link
        href="/dashboard/schedules"
        className={`sh-nav-item ${active === 'schedules' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↻</span> Schedules
      </Link>
      <Link
        href="/dashboard/compliance"
        className={`sh-nav-item ${active === 'compliance' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">⚑</span> Compliance
      </Link>
      {isAdmin && (
        <>
          <div className="sh-nav-label">Account</div>
          <Link
            href="/dashboard/team"
            className={`sh-nav-item ${active === 'team' ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">◉</span> Team
          </Link>
          <Link href="/dashboard" className="sh-nav-item">
            <span className="sh-nav-icon">⚙</span> Settings
          </Link>
        </>
      )}
    </aside>
  );
}
