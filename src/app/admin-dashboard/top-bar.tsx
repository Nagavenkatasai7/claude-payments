import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';
import { LiveRefresh } from './live-refresh';
import { MobileMenuButton } from './mobile-nav';
import { CommandPalette } from './command-palette';
import { buildCommandItems } from './command-items';
import { resolveNavItems } from './nav';
import { Icon } from './icons';

export async function TopBar() {
  const staff = await requireStaff();
  const initial = staff.name.charAt(0).toUpperCase();
  const navItems = resolveNavItems(staff);
  const commandItems = buildCommandItems(navItems, {
    isPlatformAdmin: staff.role === 'admin' && !staff.partnerId,
    isAdmin: staff.role === 'admin',
  });

  return (
    <header className="sh-topbar">
      <MobileMenuButton />
      <div className="sh-brand">
        <div className="sh-brand-mark">SR</div>
        SmartRemit
      </div>
      <CommandPalette items={commandItems} />
      <div className="sh-top-right">
        <LiveRefresh />
        <div className="sh-user">
          <div className="sh-avatar">{initial}</div>
          <span>{staff.name}</span>
        </div>
        <form action={logout}>
          <button type="submit" className="sh-btn-secondary">
            <Icon name="logout" />
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
