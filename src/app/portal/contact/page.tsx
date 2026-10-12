import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalCustomer } from '@/lib/portal-auth';
import { portalSupportEnabled } from '@/lib/portal-tickets';
import { COMPANY, COMPANY_ADDRESS } from '@/lib/company';
import { waLink, WA_MESSAGES, WA_PHONE, formatWaPhone } from '@/app/landing/wa';
import { t } from '@/lib/i18n';
import { Button, Card, PageHeader } from '@/components/ds';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.contact.title');

const H2 = 'text-[18px] font-bold text-ds-ink';
const BODY = 'mt-2 text-[15px] leading-relaxed text-ds-ink-muted';

/**
 * Contact us (owner, 2026-10-11). Opens WITHOUT sign-in, so a visitor who cannot sign in still reaches
 * the company. WhatsApp comes first (the working channel: the bot opens a case with request_human_help),
 * then a support request for a signed-in customer, then the email and the mailing address as plain text.
 * No mailto: link and no email form: outbound email (Hostinger SMTP) does not work today.
 */
export default async function PortalContactPage() {
  const site = await requirePortalSite();
  const customer = await getPortalCustomer();
  const supportOn = customer ? await portalSupportEnabled(site.partnerId) : false;
  return (
    <>
      <PageHeader title={t('portal.contact.title')} sub={t('portal.contact.sub', { brand: site.brand })} />
      <div className="flex flex-col gap-6">
        <Card as="section">
          <h2 className={H2}>{t('portal.contact.whatsappTitle')}</h2>
          <p className={BODY}>{t('portal.contact.whatsappBody')}</p>
          <p className="mt-3 text-[15px] font-semibold text-ds-ink">{formatWaPhone(WA_PHONE)}</p>
          <div className="mt-4">
            <Button asChild size="md">
              <a href={waLink(WA_MESSAGES.generic)} target="_blank" rel="noopener noreferrer">
                <MessageCircle aria-hidden="true" className="size-4" />
                {t('portal.contact.whatsappCta')}
              </a>
            </Button>
          </div>
        </Card>

        <Card as="section">
          <h2 className={H2}>{t('portal.contact.supportTitle')}</h2>
          {customer ? (
            <>
              {supportOn ? <p className={BODY}>{t('portal.contact.supportBody')}</p> : null}
              <div className="mt-4 flex flex-wrap gap-3">
                {supportOn ? (
                  <Button asChild size="md">
                    <Link href="/portal/help/tickets/new">{t('portal.help.newCta')}</Link>
                  </Button>
                ) : null}
                <Button asChild variant="ghost" size="md">
                  <Link href="/portal/chat">{t('portal.help.chatCta')}</Link>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className={BODY}>{t('portal.contact.supportSignedOutBody')}</p>
              <div className="mt-4">
                <Button asChild variant="ghost" size="md">
                  <Link href={`/portal/login?next=${encodeURIComponent('/portal/help')}`}>{t('portal.contact.signInCta')}</Link>
                </Button>
              </div>
            </>
          )}
        </Card>

        <Card as="section">
          <h2 className={H2}>{t('portal.contact.emailTitle')}</h2>
          <p className="mt-2 text-[15px] text-ds-ink select-all">{COMPANY.supportEmail}</p>
          <h2 className={`${H2} mt-6`}>{t('portal.contact.mailTitle')}</h2>
          <address className="mt-2 text-[15px] not-italic leading-relaxed text-ds-ink">
            {COMPANY.legalName}
            <br />
            {COMPANY_ADDRESS}
          </address>
        </Card>
      </div>
    </>
  );
}
