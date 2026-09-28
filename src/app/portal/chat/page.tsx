import type { Metadata } from 'next';
import { getPortalSite, requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { t } from '@/lib/i18n';
import { PageHeader } from '@/components/ds';
import { ChatClient } from '@/app/account/chat/chat-client';

export async function generateMetadata(): Promise<Metadata> {
  return (await getPortalSite()) ? { title: t('portal.chat.title') } : {};
}

/**
 * Chat (UI redesign M2-12, Task 12.3): the existing web-chat assistant, reused by import with the
 * portal's endpoint (/api/portal/chat: same origin, so CSP `connect-src 'self'` covers it) and the
 * portal's copy. The endpoint self-gates; this page gates too (the layout is never the guard).
 */
export default async function PortalChatPage() {
  const site = await requirePortalSite();
  await requirePortalCustomer();
  return (
    <>
      <PageHeader title={t('portal.chat.title')} sub={t('portal.chat.sub', { brand: site.brand })} />
      <p role="note" className="mb-5 rounded-ds-inner border border-ds-border bg-ds-tint px-4 py-3 text-[14px] text-ds-ink">
        {t('portal.chat.notice')}
      </p>
      <ChatClient
        endpoint="/api/portal/chat"
        copy={{
          intro: t('portal.chat.intro'),
          placeholder: t('portal.chat.placeholder'),
          inputLabel: t('portal.chat.inputLabel'),
          send: t('portal.chat.send'),
          typing: t('portal.chat.typing'),
          genericError: t('portal.chat.error.generic'),
          unreachable: t('portal.chat.unreachable'),
        }}
      />
    </>
  );
}
