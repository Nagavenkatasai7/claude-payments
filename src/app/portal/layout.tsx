import type { ReactNode } from 'react';
import { requirePortalSite } from '@/lib/portal-site';
import { portalMetadata } from '@/lib/portal-metadata';
import { getPortalCustomer } from '@/lib/portal-auth';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import { portalNavItems } from '@/lib/portal-nav';
import { Sidebar, Button } from '@/components/ds';
import { SiteBrand } from '@/components/ds/site-brand';
import { SiteThemeStyle } from '@/components/ds/site-theme-style';
import { signOutAction } from './signout/actions';

// Site-only (L8): on the apex the whole tree is the root 404, whose head must match any unmatched URL.
export const generateMetadata = () => portalMetadata(null, { robots: { index: false, follow: false } });
// Per-request only (Host, flag, per-partner enablement, session): never prerendered.
export const dynamic = 'force-dynamic';

/**
 * The customer portal shell (UI redesign M2-5, Task 5.7): the partner's theme and brand in the
 * landing look (D11). The gate runs FIRST, so on the apex (or with the portal off) the whole tree
 * falls through to the brand-neutral root 404. It does not require a customer (sign-in lives
 * under it); the nav and sign-out show only for a signed-in customer.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const site = await requirePortalSite();
  const customer = await getPortalCustomer();
  return (
    <>
      <SiteThemeStyle theme={site.theme} />
      <div className="ds-site" lang="en">
        <div className="min-h-dvh bg-ds-ground text-ds-ink">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-ds-inner focus:bg-ds-surface focus:px-4 focus:py-2"
          >
            {t('portal.skip')}
          </a>
          <header className="flex items-center justify-between gap-4 border-b border-ds-border bg-ds-surface px-4 py-3 sm:px-6 print:hidden">
            <SiteBrand brand={site.brand} logo={site.logo} />
            {customer ? (
              <form action={signOutAction}>
                <Button type="submit" variant="ghost" size="sm">
                  {t('portal.signout')}
                </Button>
              </form>
            ) : null}
          </header>
          <div className={customer ? 'md:grid md:grid-cols-[240px_1fr] print:block' : undefined}>
            {customer ? (
              <div className="print:hidden">
                <Sidebar label={t('portal.nav.label')} items={portalNavItems(env.customerDataRightsEnabled)} />
              </div>
            ) : null}
            <main id="main" className="sh-main mx-auto w-full max-w-3xl bg-transparent px-4 py-8 sm:px-6">
              {children}
            </main>
          </div>
        </div>
      </div>
    </>
  );
}
