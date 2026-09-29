import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { loadSiteTheme } from '@/db/repos/partner-site-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { MAX_LOGO_FILE_KB } from '@/lib/partner-branding';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { ContactForm, LogoForm, ThemeForm } from './branding-forms';
import { BrandPreview } from './preview';

export const metadata: Metadata = { title: t('partner.branding.title'), robots: { index: false, follow: false } };

// /partner/branding (UI redesign M3-17): the tenant's logo, colours and support contact. The page
// gates itself (admin only, MFA enforced; the layout's gate is chrome only). Everything is read
// for the SESSION's partner only. Colours come from loadSiteTheme (always re-validated), the logo
// reaches the page only through SiteBrand as an <img src> (never CSS, never an app route), and the
// support contact is rendered as escaped text. The writes are the server actions in ./actions.
export default async function PartnerBrandingPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);
  const [partner, theme] = await Promise.all([getPartnerStore().getPartner(ctx.partnerId), loadSiteTheme(getDb(), ctx.partnerId)]);
  const branding = resolvePartnerBranding(partner);
  const logo = partner?.logoUrl ?? null;

  return (
    <>
      <PageHeader title={t('partner.branding.title')} sub={t('partner.branding.sub')} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4">
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.colorsTitle')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.colorsIntro')}</p>
            <ThemeForm primary={theme.primary} accent={theme.accent} />
          </Card>
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.logoTitle')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.logoIntro', { max: MAX_LOGO_FILE_KB })}</p>
            <LogoForm />
          </Card>
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.contactTitle')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.contactIntro')}</p>
            <ContactForm current={branding.supportContact} />
          </Card>
        </div>
        <Card as="aside" className="min-w-0 p-5 sm:p-6 lg:sticky lg:top-24">
          <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.previewTitle')}</h2>
          <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.previewIntro')}</p>
          <BrandPreview theme={theme} brand={branding.brand} logo={logo} supportContact={branding.supportContact} />
        </Card>
      </div>
    </>
  );
}
