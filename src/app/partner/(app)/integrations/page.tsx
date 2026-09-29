import Link from 'next/link';
import type { Metadata } from 'next';
import { ChevronRight, KeyRound, MessageCircle, Webhook } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Card, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';

export const metadata: Metadata = { title: t('partner.integrations.title'), robots: { index: false, follow: false } };

// /partner/integrations (UI redesign M3-13): the hub for the three integration pages. Admin only;
// it reads no tenant data. A tab links only to a route present in PARTNER_ROUTES (webhooks arrive
// with M3-15; until then it is text).
type Tab = { key: string; title: MessageKey; body: MessageKey; Icon: typeof MessageCircle; href?: string };
const TABS: readonly Tab[] = [
  { key: 'whatsapp', title: 'partner.integrations.whatsapp.title', body: 'partner.integrations.whatsapp.body', Icon: MessageCircle, href: PARTNER_ROUTES.integrationsWhatsapp.href },
  { key: 'api-keys', title: 'partner.integrations.apiKeys.title', body: 'partner.integrations.apiKeys.body', Icon: KeyRound, href: PARTNER_ROUTES.integrationsApiKeys.href },
  { key: 'webhooks', title: 'partner.integrations.webhooks.title', body: 'partner.integrations.webhooks.body', Icon: Webhook },
];

export default async function PartnerIntegrationsPage() {
  await requirePartnerStaff(PARTNER_ROUTES.integrations.policy);
  return (
    <>
      <PageHeader title={t('partner.integrations.title')} sub={t('partner.integrations.sub')} />
      <ul className="grid gap-4 md:grid-cols-3">
        {TABS.map(({ key, title, body, Icon, href }) => (
          <Card as="li" key={key} className="flex flex-col gap-3 p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <Icon aria-hidden="true" className="size-5 shrink-0 text-ds-primary" />
              <h2 className="text-[17px] font-semibold text-ds-ink">{t(title)}</h2>
            </div>
            <p className="text-[14px] leading-relaxed text-ds-ink-muted">{t(body)}</p>
            <div className="mt-auto">
              {href ? (
                <Link
                  href={href}
                  className="inline-flex min-h-11 items-center gap-1 rounded-ds-focus text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
                >
                  {t('partner.integrations.open')}
                  <span className="sr-only"> {t(title)}</span>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              ) : (
                <Badge>{t('partner.integrations.soon')}</Badge>
              )}
            </div>
          </Card>
        ))}
      </ul>
    </>
  );
}
