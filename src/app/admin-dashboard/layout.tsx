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
      <div className="sh-app">
        <TopBar />
        <div className="sh-body">{children}</div>
      </div>
      <MobileNavDrawer items={navItems} />
    </DrawerProvider>
  );
}
