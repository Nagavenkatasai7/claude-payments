import { t } from '@/lib/i18n';
import { buttonVariants } from '@/components/ds';
import { SiteBrand } from '@/components/ds/site-brand';
import { SiteThemeStyle } from '@/components/ds/site-theme-style';
import type { SiteTheme } from '@/lib/ui/theme';

// The Branding preview (UI redesign M3-17): the partner's SAVED brand in the landing look, as
// customers see it on the partner site (SPEC D11). It reuses the M1 pieces unchanged:
//  - SiteThemeStyle re-validates both colours and emits only `.ds-site{…}` custom properties, so
//    the theme applies inside the .ds-site wrapper below and nowhere else in the /partner shell;
//  - SiteBrand renders the stored logo only as an <img src> (never CSS), or the brand as text.
// .ds-site is `display: contents`, so the visible frame is the inner div. The button is a static
// sample (not interactive) and there is no heading here: the page keeps its own h1/h2 outline.
export function BrandPreview({
  theme,
  brand,
  logo,
  supportContact,
}: {
  theme: SiteTheme;
  brand: string;
  logo: unknown;
  supportContact: string;
}) {
  return (
    <>
      <SiteThemeStyle theme={theme} />
      <div className="ds-site" data-testid="branding-preview">
        <div className="overflow-hidden rounded-ds-inner border border-ds-border bg-ds-ground">
          <div className="flex min-h-14 items-center border-b border-ds-border bg-ds-surface px-4 py-3">
            <span className="min-w-0 truncate text-[17px]">
              <SiteBrand brand={brand} logo={logo} />
            </span>
          </div>
          <div className="h-1 bg-[image:var(--ds-gradient-bar)]" aria-hidden="true" />
          <div className="flex flex-col items-start gap-4 px-4 py-6">
            <p className="bg-[image:var(--ds-gradient-text)] bg-clip-text text-[24px] leading-tight font-extrabold tracking-[-0.02em] text-transparent">
              {t('partner.branding.previewHeadline')}
            </p>
            <span aria-hidden="true" className={buttonVariants({ variant: 'primary', size: 'md' })}>
              <span className="inline-flex items-center">{t('partner.branding.previewButton')}</span>
            </span>
            <p className="text-[13.5px] break-words text-ds-ink-muted">
              {supportContact
                ? t('partner.branding.previewHelp', { contact: supportContact })
                : t('partner.branding.previewNoContact')}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
