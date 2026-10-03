import Link from 'next/link';
import { LifeBuoy, MessageCircle } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { portalSupportEnabled } from '@/lib/portal-tickets';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Card, PageHeader } from '@/components/ds';
import { portalMetadata } from '@/lib/portal-metadata';

// The title is set only on a portal host: an apex 404 carries no portal copy (the M2-5 review, L8).
export const generateMetadata = () => portalMetadata('portal.help.title');

const FAQ: ReadonlyArray<{ q: MessageKey; a: MessageKey }> = [
  { q: 'portal.help.faq.track.q', a: 'portal.help.faq.track.a' },
  { q: 'portal.help.faq.cancel.q', a: 'portal.help.faq.cancel.a' },
  { q: 'portal.help.faq.time.q', a: 'portal.help.faq.time.a' },
  { q: 'portal.help.faq.security.q', a: 'portal.help.faq.security.a' },
];

/**
 * Help (UI redesign M2-12, Task 12.2): a static FAQ in the partner's brand (white-label: no platform
 * name), and the way into support requests and chat. The gates run on every render.
 */
export default async function PortalHelpPage() {
  const site = await requirePortalSite();
  await requirePortalCustomer('/portal/help');
  const supportOn = await portalSupportEnabled(site.partnerId);
  return (
    <>
      <PageHeader title={t('portal.help.title')} sub={t('portal.help.sub', { brand: site.brand })} />
      <div className="flex flex-col gap-6">
        <Card as="section">
          <h2 className="mb-4 text-[18px] font-bold text-ds-ink">{t('portal.help.faqTitle')}</h2>
          <div className="flex flex-col divide-y divide-ds-border">
            {FAQ.map((item) => (
              <details key={item.q} className="group py-3">
                <summary className="cursor-pointer list-none text-[15px] font-semibold text-ds-ink marker:hidden focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring">
                  {t(item.q)}
                </summary>
                <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{t(item.a, { brand: site.brand })}</p>
              </details>
            ))}
          </div>
        </Card>

        <Card as="section">
          {supportOn ? (
            <>
              <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.help.contactTitle')}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{t('portal.help.contactBody')}</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild size="md">
                  <Link href="/portal/help/tickets/new">{t('portal.help.newCta')}</Link>
                </Button>
                <Button asChild variant="ghost" size="md">
                  <Link href="/portal/help/tickets">
                    <LifeBuoy aria-hidden="true" className="size-4" />
                    {t('portal.help.ticketsCta')}
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="md">
                  <Link href="/portal/chat">
                    <MessageCircle aria-hidden="true" className="size-4" />
                    {t('portal.help.chatCta')}
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.help.supportOffTitle')}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{t('portal.help.supportOffBody', { brand: site.brand })}</p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
