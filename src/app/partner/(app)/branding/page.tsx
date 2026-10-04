import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerSite } from '@/db/repos/partner-site-repo';
import { partnerMayClaimSlug } from '@/lib/partner-slug-policy';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { ContactForm, PersonaForm } from './branding-forms';
import { SlugClaimForm } from './slug-form';

export const metadata: Metadata = { title: t('partner.branding.title'), robots: { index: false, follow: false } };

// /partner/branding (UI redesign M3-17), shown as "Portal settings": the tenant's web address,
// support contact and assistant tone. Customer pages carry the SmartRemit brand only (owner decision,
// 2026-10-04), so the page no longer offers or shows a partner logo, colours, display name or preview
// (the stored values are kept, unused). The page gates itself (admin only, MFA enforced; the layout's
// gate is chrome only). Everything is read for the SESSION's partner only, and the support contact and
// tone are rendered as escaped text. The writes are the server actions in ./actions and (M3-18) the
// one-time web-address claim in ./slug-actions; once claimed, the slug is read-only here.
export default async function PartnerBrandingPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);
  const [partner, site] = await Promise.all([
    getPartnerStore().getPartner(ctx.partnerId),
    getPartnerSite(getDb(), ctx.partnerId),
  ]);
  const branding = resolvePartnerBranding(partner);

  return (
    <>
      <PageHeader title={t('partner.branding.title')} sub={t('partner.branding.sub')} />
      <div className="grid max-w-3xl gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.slug.title')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.slug.intro')}</p>
            {partnerMayClaimSlug(site) ? (
              <SlugClaimForm />
            ) : (
              <div data-testid="branding-slug-current" className="flex flex-col gap-2">
                <p className="text-[14px] font-semibold text-ds-ink">{t('partner.slug.current')}</p>
                <p className="break-all font-mono text-[15px] text-ds-ink">{`${site?.slug ?? ''}.smartremit.ai`}</p>
                <p className="text-[14px] text-ds-ink-muted">{t('partner.slug.contactSmartRemit')}</p>
              </div>
            )}
          </Card>
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.contactTitle')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.contactIntro')}</p>
            <ContactForm current={branding.supportContact} />
          </Card>
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="text-[18px] font-extrabold text-ds-ink">{t('partner.branding.personaTitle')}</h2>
            <p className="mt-1 mb-4 text-[14px] text-ds-ink-muted">{t('partner.branding.personaIntro')}</p>
            <PersonaForm current={partner?.botPersona ?? ''} />
          </Card>
        </div>
      </div>
    </>
  );
}
