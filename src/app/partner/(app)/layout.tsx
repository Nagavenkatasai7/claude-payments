import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ANY } from '@/lib/partner-access';
import { getPartnerStore } from '@/lib/partner-store';
import { t } from '@/lib/i18n';
import { buttonVariants } from '@/components/ds';
import { SiteBrand } from '@/components/ds/site-brand';
import { logout } from '@/app/login/actions';
import { partnerNav } from '../routes';
import { PartnerSidebar } from './partner-sidebar';

// The /partner shell (UI redesign M3-2), in the landing look (SPEC D11): the landing's ground,
// ink, type and focus ring, its sticky translucent top bar, and ds primitives only. The partner's
// logo and colours arrive with Branding (M3-17); until then the brand is the partner's name as text.
//
// The gate here is for the CHROME only. A layout does not re-render on navigation and does not
// stop child segments rendering (next/dist/docs/01-app/02-guides/authentication.md "Layouts and
// auth checks"), so every page calls requirePartnerStaff itself. skipMfa: an enrolment-pending
// user must still see the shell around /partner/security (the pages enforce enrolment), otherwise
// the security page's own layout would redirect to itself.
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
  } catch {
    return '';
  }
}

export default async function PartnerAppLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePartnerStaff(PARTNER_ANY, { skipMfa: true });
  const brand = await brandName(ctx.partnerId);
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
          <form action={logout} className="ml-auto shrink-0">
            <button type="submit" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              <LogOut aria-hidden="true" className="size-4" />
              {t('partner.shell.signOut')}
            </button>
          </form>
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-[1180px] gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8 lg:py-8">
        <PartnerSidebar label={t('partner.nav.label')} menuLabel={t('partner.nav.menu')} items={items} />
        <main id="main" className="sh-main min-w-0 bg-transparent p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
