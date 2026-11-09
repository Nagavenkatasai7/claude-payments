import type { ReactNode } from 'react';
import { requirePortalSite } from '@/lib/portal-site';
import { portalLayoutMetadata } from '@/lib/portal-metadata';
import { skinLogoSrc } from '@/lib/site-skins';
import { getPortalCustomer } from '@/lib/portal-auth';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import { portalNavItems } from '@/lib/portal-nav';
import { agentPortal } from '@/lib/agent-auth/portal-wiring';
import { Sidebar, Button } from '@/components/ds';
import { SiteThemeStyle } from '@/components/ds/site-theme-style';
import Link from 'next/link';
import BrandLogo from '@/app/landing/BrandLogo';
import { signOutAction } from './signout/actions';
import { APEX_URL, companyFooterLine } from '@/lib/company';

// Site-only (L8): on the apex the whole tree is the root 404, whose head must match any unmatched URL.
// On a skin host the tab title of each page also names the skin ("Sign in · TGFL").
export const generateMetadata = () => portalLayoutMetadata({ robots: { index: false, follow: false } });
// Per-request only (Host, flag, per-partner enablement, session): never prerendered.
export const dynamic = 'force-dynamic';

/**
 * The customer portal shell (UI redesign M2-5, Task 5.7) in the landing look (D11). SmartRemit is the
 * only brand (owner decision, 2026-10-04): the header is the SmartRemit.ai logo and the colours are
 * SmartRemit's, never the partner's. The gate runs FIRST, so on the apex (or with the portal off) the whole tree
 * falls through to the brand-neutral root 404. It does not require a customer (sign-in lives
 * under it); the nav and sign-out show only for a signed-in customer.
 *
 * The ONE exception (owner go 2026-11-09): a site skin (src/lib/site-skins.ts, e.g. tgfl.smartremit.ai).
 * There the header shows the skin's name (or its logo file) in place of the SmartRemit logo, a demo
 * line sits under the header on every page, the footer adds "Powered by SmartRemit", and the skin's
 * colours apply when it has any (validated again by SiteThemeStyle). Nothing else changes: the pages,
 * the company line and the legal links are SmartRemit's, and `site.brand` stays SmartRemit. A
 * PARTNER's name, logo and colours are still never shown. Without a skin the markup is unchanged.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const site = await requirePortalSite();
  const skin = site.skin ?? null;
  // Only a file under /brand/partners/ renders; anything else falls back to the name as text.
  const skinLogo = skin ? skinLogoSrc(skin) : null;
  const customer = await getPortalCustomer();
  // Stage C1: "Connected AI apps" shows while the gate is open or the customer has a live grant
  // (fails closed and time-bounded; the page gates itself as well).
  const agentApps = customer ? await agentPortal().visible(site.partnerId, customer.session.phone) : false;
  return (
    <>
      <div className="ds-site" lang="en">
        {skin?.theme ? <SiteThemeStyle theme={skin.theme} /> : null}
        <div className="min-h-dvh bg-ds-ground text-ds-ink">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-ds-inner focus:bg-ds-surface focus:px-4 focus:py-2"
          >
            {t('portal.skip')}
          </a>
          <header className="flex items-center justify-between gap-4 border-b border-ds-border bg-ds-surface px-4 py-3 sm:px-6 print:hidden">
            <Link href="/portal" className="inline-flex rounded-ds-focus">
              {!skin ? (
                <BrandLogo height={36} eager className="h-8 sm:h-9" />
              ) : skinLogo ? (
                // A same-origin file under /brand/partners/ of unknown size; next/image needs fixed dimensions.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={skinLogo} alt={skin.name} className="h-8 w-auto sm:h-9" />
              ) : (
                <span data-skin-brand className="text-xl font-extrabold tracking-tight text-ds-ink sm:text-2xl">
                  {skin.name}
                </span>
              )}
            </Link>
            {customer ? (
              <form action={signOutAction}>
                <Button type="submit" variant="ghost" size="sm">
                  {t('portal.signout')}
                </Button>
              </form>
            ) : null}
          </header>
          {skin?.demo ? (
            <p
              data-skin-demo
              role="note"
              className="border-b border-ds-border bg-ds-surface px-4 py-2 text-center text-[13px] text-ds-ink-muted sm:px-6 print:hidden"
            >
              {t('portal.skin.demo', { name: skin.name, brand: site.brand })}
            </p>
          ) : null}
          <div className={customer ? 'md:grid md:grid-cols-[240px_1fr] print:block' : undefined}>
            {customer ? (
              <div className="print:hidden">
                <Sidebar label={t('portal.nav.label')} items={portalNavItems(env.customerDataRightsEnabled, { agentApps })} />
              </div>
            ) : null}
            <main id="main" className="sh-main mx-auto w-full max-w-3xl bg-transparent px-4 py-8 sm:px-6">
              {children}
            </main>
          </div>
          {/* Owner, 2026-10-11: the company line, Contact us and the legal pages (apex-only routes). */}
          <footer className="border-t border-ds-border bg-ds-surface px-4 py-5 text-[13px] text-ds-ink-muted sm:px-6 print:hidden">
            <nav aria-label={t('portal.footer.legal')} className="flex flex-wrap gap-x-5 gap-y-2">
              <Link href="/portal/contact" className="hover:text-ds-ink">
                {t('portal.nav.contact')}
              </Link>
              <a href={`${APEX_URL}/terms`} className="hover:text-ds-ink">
                {t('portal.footer.terms')}
              </a>
              <a href={`${APEX_URL}/privacy`} className="hover:text-ds-ink">
                {t('portal.footer.privacy')}
              </a>
              <a href={`${APEX_URL}/legal`} className="hover:text-ds-ink">
                {t('portal.footer.licensing')}
              </a>
            </nav>
            {skin ? (
              <p data-skin-powered className="mt-3 font-semibold text-ds-ink">
                {t('portal.skin.poweredBy', { brand: site.brand })}
              </p>
            ) : null}
            <p className="mt-3">{companyFooterLine(new Date().getFullYear())}</p>
          </footer>
        </div>
      </div>
    </>
  );
}
