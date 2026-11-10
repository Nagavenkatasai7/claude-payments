import type { ReactNode } from 'react';
import { requirePortalSite, type PortalSite } from '@/lib/portal-site';
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
 * There the header shows the skin's name (after its logo file, when it has one) in place of the SmartRemit logo, a demo
 * line sits under the header on every page, the footer adds "Powered by SmartRemit", and the skin's
 * colours apply when it has any (validated again by SiteThemeStyle). Nothing else changes: the pages,
 * the company line and the legal links are SmartRemit's, and `site.brand` stays SmartRemit. A
 * PARTNER's name, logo and colours are still never shown. Without a skin the markup is unchanged.
 */
/** The header logo is at most this tall (the sm:max-h-9 cap); a smaller file keeps its natural size. */
const SKIN_LOGO_MAX_HEIGHT = 36;

/**
 * The skin logo's <img> attributes, or null (the header then shows the name alone). It needs a file
 * under /brand/partners/ (skinLogoSrc) and its natural size: width and height are set from that size
 * so the layout does not shift while the file loads, and never above it.
 */
function skinLogoImage(skin: NonNullable<PortalSite['skin']>): { src: string; width: number; height: number } | null {
  const src = skinLogoSrc(skin);
  const size = skin.logoSize;
  const dim = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!src || !size || !dim(size.width) || !dim(size.height)) return null;
  const height = Math.min(SKIN_LOGO_MAX_HEIGHT, size.height);
  return { src, height, width: Math.max(1, Math.round((height * size.width) / size.height)) };
}

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const site = await requirePortalSite();
  const skin = site.skin ?? null;
  // Only a file under /brand/partners/ with its size renders; the name always shows as text.
  const skinLogo = skin ? skinLogoImage(skin) : null;
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
              ) : (
                <span className="inline-flex items-center gap-2">
                  {skinLogo ? (
                    // A small same-origin static file under /brand/partners/ of known size: a plain <img> is enough.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={skinLogo.src}
                      alt={skin.name}
                      width={skinLogo.width}
                      height={skinLogo.height}
                      className="h-auto w-auto max-h-8 sm:max-h-9"
                    />
                  ) : null}
                  {/* The name stays as text: a logo's own lettering is too small to read at header size. */}
                  <span data-skin-brand className="text-xl font-extrabold tracking-tight text-ds-ink sm:text-2xl">
                    {skin.name}
                  </span>
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
