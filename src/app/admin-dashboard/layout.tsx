import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { requireStaff } from '@/lib/auth';
import { resolveNavItems } from './nav';
import { TopBar } from './top-bar';
import { DrawerProvider, MobileNavDrawer } from './mobile-nav';
import { KillSwitchBanner } from './kill-switch-banner';

// SmartRemit-owned surface: the SmartRemit.ai tab icon for the whole subtree
// (see ../brand-icons.ts for why icons are per-route, not app/icon.png).
export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Resolve the nav once here so the mobile drawer (a client component) gets plain
  // serializable data; the desktop <Sidebar> still resolves its own per page.
  const staff = await requireStaff();
  const navItems = resolveNavItems(staff);

  // .admin-brand (tailwind.css) re-points the shadcn tokens to the SmartRemit landing palette for the
  // whole subtree, drawer included; it is box-less (display: contents), so the layout is unchanged.
  return (
    <div className="admin-brand">
    <DrawerProvider>
      <div className="grid min-h-svh grid-rows-[60px_auto_1fr] bg-background font-sans text-foreground antialiased">
        <TopBar />
        {/* Release safety: the red kill-switch banner. The wrapper is always present so
            the page column keeps its grid row; it is empty while every switch is off. */}
        <div>
          <KillSwitchBanner />
        </div>
        {/* Sidebar + page column. Pages render `<Sidebar …/><main className="sh-main">…`
            as the two grid children; ≤1024px collapses to a single column and the
            off-canvas drawer (below) takes over from the static sidebar. */}
        <div className="grid min-h-0 grid-cols-1 min-[1025px]:grid-cols-[240px_minmax(0,1fr)]">
          {children}
        </div>
      </div>
      <MobileNavDrawer items={navItems} />
    </DrawerProvider>
    </div>
  );
}
