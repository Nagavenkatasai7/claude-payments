import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { requireStaff } from '@/lib/auth';
import { resolveNavItems } from './nav';
import { TopBar } from './top-bar';
import { DrawerProvider, MobileNavDrawer } from './mobile-nav';
import { scopeOf } from '@/lib/staff-scope';
import { getStore } from '@/lib/store';
import { channelBannerModel, parseHealthMarks, summarizeChannelHealth, type ChannelBannerModel } from '@/lib/channel-health';
import { ChannelHealthBanner } from './channel-health-banner';
import { readSignatureHealth } from '@/lib/webhook-signature-health';

/**
 * R2a: partner staff see their OWN tenant's WhatsApp channel signals on every
 * dashboard page. The tenant comes from scopeOf(staff) only (never a param).
 * Redis reads only (the health marks + R2b's signature marks) — no DB, no
 * decrypt — and best-effort: a Redis error ⇒ no banner.
 */
async function partnerChannelBanner(staff: Awaited<ReturnType<typeof requireStaff>>): Promise<ChannelBannerModel | null> {
  try {
    const scope = scopeOf(staff);
    if (scope.kind !== 'partner') return null;
    const [raw, signature] = await Promise.all([getStore().readChannelHealth(scope.partnerId), readSignatureHealth(scope.partnerId)]);
    const marks = parseHealthMarks(raw);
    return channelBannerModel(summarizeChannelHealth({ marks, now: new Date(), signature }), scope.partnerId);
  } catch {
    return null;
  }
}

// SmartRemit-owned surface: the SmartRemit.ai tab icon for the whole subtree
// (see ../brand-icons.ts for why icons are per-route, not app/icon.png).
export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Resolve the nav once here so the mobile drawer (a client component) gets plain
  // serializable data; the desktop <Sidebar> still resolves its own per page.
  const staff = await requireStaff();
  const navItems = resolveNavItems(staff);
  const channelBanner = await partnerChannelBanner(staff);

  return (
    <DrawerProvider>
      <div
        className={`grid min-h-svh ${channelBanner ? 'grid-rows-[56px_auto_1fr]' : 'grid-rows-[56px_1fr]'} bg-background text-foreground`}
      >
        <TopBar />
        {channelBanner && (
          <div className="px-4 pt-3">
            <ChannelHealthBanner model={channelBanner} showLink />
          </div>
        )}
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
