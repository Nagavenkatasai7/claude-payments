import type { ReactNode } from 'react';
import Link from 'next/link';
import { CircleAlert, LogOut, TriangleAlert } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ANY, type PartnerRole } from '@/lib/partner-access';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { parseHealthMarks, summarizeChannelHealth } from '@/lib/channel-health';
import { readSignatureHealth } from '@/lib/webhook-signature-health';
import { shellChannelBanner, type ShellChannelBanner } from '@/lib/partner-shell-health';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { buildPartnerCommands, openCommandScope } from '@/lib/partner-commands';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { buttonVariants } from '@/components/ds';
import { SiteBrand } from '@/components/ds/site-brand';
import { logout } from '@/app/login/actions';
import { PARTNER_ROUTES, partnerNav } from '../routes';
import { PartnerSidebar } from './partner-sidebar';
import { PartnerPalette } from './partner-palette';
import { PartnerLiveRefresh } from './live-refresh';

// The /partner shell (UI redesign M3-2), in the landing look (SPEC D11): the landing's ground,
// ink, type and focus ring, its sticky translucent top bar, and ds primitives only. The partner's
// logo and colours arrive with Branding (M3-17); until then the brand is the partner's name as text.
//
// The gate here is for the CHROME only. A layout does not re-render on navigation and does not
// stop child segments rendering (next/dist/docs/01-app/02-guides/authentication.md "Layouts and
// auth checks"), so every page calls requirePartnerStaff itself. skipMfa: an enrolment-pending
// user must still see the shell around /partner/security (the pages enforce enrolment). Without
// it, THIS layout (which also wraps /partner/security) would redirect to /partner/security on every
// render of that page: a loop. There is no separate security layout.
const ROOT =
  'min-h-dvh overflow-x-clip bg-ds-ground font-sans leading-[1.6] text-ds-ink antialiased ' +
  '[&_:focus-visible]:rounded-ds-focus [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[3px] [&_:focus-visible]:outline-ds-focus-ring';

async function brandName(partnerId: string): Promise<string> {
  // Only the lookup is guarded: a layout error is not caught by this segment's error.tsx, and a
  // missing brand must never take the whole workspace down. The gate is never inside a try/catch
  // (redirect() works by throwing).
  try {
    const p = await getPartnerStore().getPartner(partnerId);
    return p?.displayName ?? p?.name ?? '';
  } catch (err) {
    logWarn('partner.shell', 'brand lookup failed', { err });
    return '';
  }
}

/**
 * Lost-features p3 B12: the tenant's WhatsApp health on every page, as the legacy shell had it.
 * Redis only (the health marks + the signature marks): no Neon, no decrypt. Best-effort: any error
 * means no strip (a layout error is not caught by the segment's error.tsx). The default tenant IS
 * the shared number, so its marks are the platform's, not a partner signal (as on Home). A layout
 * does not re-render on client navigation, so the strip updates on a full load or a refresh.
 */
async function channelBanner(partnerId: string, role: PartnerRole): Promise<ShellChannelBanner | null> {
  if (partnerId === DEFAULT_PARTNER_ID) return null;
  try {
    const [raw, signature] = await Promise.all([getStore().readChannelHealth(partnerId), readSignatureHealth(partnerId)]);
    return shellChannelBanner(summarizeChannelHealth({ marks: parseHealthMarks(raw), now: new Date(), signature }), role);
  } catch (err) {
    logWarn('partner.shell', err instanceof Error ? err.name : 'error', { source: 'channel_health', partnerId });
    return null;
  }
}

function ChannelStrip({ banner }: { banner: ShellChannelBanner }) {
  const error = banner.level === 'error';
  const Icon = error ? CircleAlert : TriangleAlert;
  return (
    <div
      role="status"
      data-shell-banner={banner.level}
      className={
        'mx-auto mt-4 w-full max-w-[1180px] px-4 sm:px-5 ' + (error ? 'text-ds-danger-ink' : 'text-ds-warning-ink')
      }
    >
      <div
        className={
          'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-ds-inner border px-4 py-2 text-[14px] ' +
          (error ? 'border-ds-danger-border bg-ds-danger-bg' : 'border-ds-warning-border bg-ds-warning-bg')
        }
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-semibold">{error ? t('partner.shell.waError') : t('partner.shell.waWarn')}</span>
        {banner.link ? (
          <Link
            href={PARTNER_ROUTES.integrationsWhatsapp.href}
            className="ml-auto inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
          >
            {t('partner.shell.waFix')}
          </Link>
        ) : (
          <span className="ml-auto">{t('partner.shell.waTellAdmin')}</span>
        )}
      </div>
    </div>
  );
}

export default async function PartnerAppLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePartnerStaff(PARTNER_ANY, { skipMfa: true });
  const [brand, banner] = await Promise.all([brandName(ctx.partnerId), channelBanner(ctx.partnerId, ctx.role)]);
  const items = partnerNav(ctx.role).map((r) => ({ href: r.href, label: t(r.labelKey) }));

  return (
    <div className={ROOT}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-ds-inner focus:bg-ds-surface focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-ds-ink focus:shadow-ds-pop"
      >
        {t('partner.shell.skip')}
      </a>
      <header className="sticky top-0 z-50 border-b border-ds-border bg-ds-nav-bg backdrop-blur-[12px]">
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 flex-col leading-tight">
            {brand ? (
              <span className="truncate text-[17px]">
                <SiteBrand brand={brand} logo={null} />
              </span>
            ) : null}
            <span className="truncate text-[12.5px] text-ds-ink-subtle">{t('partner.shell.poweredBy')}</span>
          </div>
          {/* Lost-features A16 + A15: quick search (items filtered by the session role from the route
              table; every page re-gates) and the live indicator (list pages only). */}
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <PartnerPalette items={buildPartnerCommands(ctx.role)} scope={openCommandScope(ctx.role)} />
            <PartnerLiveRefresh />
          </div>
          <form action={logout} className="shrink-0">
            <button type="submit" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              <LogOut aria-hidden="true" className="size-4" />
              {t('partner.shell.signOut')}
            </button>
          </form>
        </div>
      </header>
      {banner !== null ? <ChannelStrip banner={banner} /> : null}
      <div className="mx-auto grid w-full max-w-[1180px] gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8 lg:py-8">
        <PartnerSidebar label={t('partner.nav.label')} menuLabel={t('partner.nav.menu')} items={items} />
        <main id="main" className="sh-main min-w-0 bg-transparent p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
