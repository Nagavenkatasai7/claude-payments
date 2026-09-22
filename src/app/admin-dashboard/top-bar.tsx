import Image from 'next/image';
import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';
import { Button } from '@/components/ui/button';
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
    isSupport: staff.role === 'support',
  });

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card px-5">
      <MobileMenuButton />
      <div className="flex flex-none items-center gap-[9px] text-[15px] font-bold tracking-[-0.3px] text-foreground">
        {/* The SmartRemit.ai mark at the old badge's 26px; decorative (the
            wordmark text beside it names the product). */}
        <Image
          src="/brand/smartremit-mark.png"
          alt=""
          width={26}
          height={26}
          loading="eager"
          className="h-[26px] w-[26px] flex-none"
        />
        SmartRemit
      </div>
      <CommandPalette items={commandItems} />
      <div className="ml-auto flex flex-none items-center gap-3.5">
        <LiveRefresh />
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground uppercase">{initial}</div>
          <span className="hidden min-[1025px]:inline">{staff.name}</span>
        </div>
        <form action={logout}>
          <Button type="submit" variant="outline">
            <Icon name="logout" />
            Log out
          </Button>
        </form>
      </div>
    </header>
  );
}
