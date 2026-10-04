import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';
import BrandLogo from '../landing/BrandLogo';
import { Button } from '@/components/ui/button';
import { LiveRefresh } from './live-refresh';
import { MobileMenuButton } from './mobile-nav';
import { CommandPalette } from './command-palette';
import { buildCommandItems } from './command-items';
import { resolveNavItems, staffRoleLabel } from './nav';
import { Icon } from './icons';

// The admin top bar in the landing look (2026-10-04): the SmartRemit.ai logo, an "Admin console" tag,
// the landing's translucent sticky bar with its brand gradient line, and the signed-in name + role.

export async function TopBar() {
  const staff = await requireStaff();
  const initial = staff.name.charAt(0).toUpperCase();
  const navItems = resolveNavItems(staff);
  const commandItems = buildCommandItems(navItems, {
    isPlatformAdmin: staff.role === 'admin' && !staff.partnerId,
    isAdmin: staff.role === 'admin',
    isSupport: staff.role === 'support',
  });

  return (
    <header className="sticky top-0 z-20 flex h-[60px] items-center gap-2 border-b border-border bg-ds-nav-bg px-3 backdrop-blur-[12px] sm:gap-3 sm:px-5">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-ds-gradient-bar" />
      <MobileMenuButton />
      <Link href="/admin-dashboard" className="flex flex-none items-center gap-2.5 rounded-md">
        <BrandLogo height={32} eager className="h-[22px] sm:h-8" />
        <span className="hidden rounded-full border border-border bg-accent px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground sm:inline">
          Admin console
        </span>
      </Link>
      <CommandPalette items={commandItems} />
      <div className="ml-auto flex flex-none items-center gap-2 sm:gap-3.5">
        <LiveRefresh />
        {/* Program-Fix 17a: the account page (change your own password). */}
        <Link
          href="/admin-dashboard/account"
          title="Your account"
          className="flex items-center gap-2.5 rounded-md text-[13px] font-medium text-foreground hover:underline"
        >
          <span className="sr-only">Account: </span>
          <div aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground uppercase">{initial}</div>
          <span className="hidden flex-col leading-tight min-[1025px]:flex">
            <span className="font-semibold">{staff.name}</span>
            <span className="text-[11.5px] text-muted-foreground">{staffRoleLabel(staff.role)}</span>
          </span>
        </Link>
        <form action={logout}>
          <Button type="submit" variant="outline" className="rounded-full max-sm:size-9 max-sm:px-0">
            <Icon name="logout" />
            <span className="hidden sm:inline">Log out</span>
            <span className="sr-only sm:hidden">Log out</span>
          </Button>
        </form>
      </div>
    </header>
  );
}
