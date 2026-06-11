import type { ReactNode } from 'react';
import { requireStaff } from '@/lib/auth';
import { resolveNavItems } from './nav';
import { TopBar } from './top-bar';
import { DrawerProvider, MobileNavDrawer } from './mobile-nav';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Resolve the nav once here so the mobile drawer (a client component) gets plain
  // serializable data; the desktop <Sidebar> still resolves its own per page.
  const staff = await requireStaff();
  const navItems = resolveNavItems(staff);

  return (
    <DrawerProvider>
      <div className="grid min-h-svh grid-rows-[56px_1fr] bg-background text-foreground">
        <TopBar />
        {/* Sidebar + page column. Pages render `<Sidebar …/><main className="sh-main">…`
            as the two grid children; ≤1024px collapses to a single column and the
            off-canvas drawer (below) takes over from the static sidebar. */}
        <div className="grid min-h-0 grid-cols-1 min-[1025px]:grid-cols-[240px_minmax(0,1fr)]">
          {children}
        </div>
      </div>
      <MobileNavDrawer items={navItems} />
    </DrawerProvider>
  );
}
