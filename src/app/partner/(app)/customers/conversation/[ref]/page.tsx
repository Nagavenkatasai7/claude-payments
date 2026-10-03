import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { openCustomerRef } from '@/lib/customer-ref';
import { CONVERSATION_PANEL_LIMIT, viewConversation } from '@/lib/conversation-view';
import { takeRevealBudget } from '@/lib/partner-reveal-throttle';
import { maskPhoneLast4 } from '@/lib/mask';
import { logWarn } from '@/lib/log';
import { t } from '@/lib/i18n';
import { Card, EmptyState, PageHeader, buttonVariants } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../../routes';

export const metadata: Metadata = {
  title: t('partner.customers.conversation.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : '—');
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * /partner/customers/conversation/[ref] (lost-features p2 A8): one customer's WhatsApp and web chat
 * log, admin only (the page gate, and viewConversation refuses any other role). The ref is opened
 * and re-scoped to the SESSION tenant (missing, foreign and junk refs are all notFound()). Opening it
 * is a deliberate, recorded read:
 *   1. one unit of the reveal budget (the same throttle as a reveal). A refusal or a Redis error
 *      shows fixed copy: no text and no audit row;
 *   2. viewConversation writes ONE `conversation.view` row (counts and channel, partner-marked)
 *      BEFORE it returns text, and throws when that write fails, so no text without a record.
 * The log holds only what the customer saw (their messages and the replies sent to them), read from
 * the sealed log, never the 30-day chat cache. Links here are prefetch={false}: a prefetch would
 * spend budget and write a view nobody made.
 */
export default async function PartnerCustomerConversationPage({ params }: { params: Promise<{ ref: string }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customerConversation.policy);
  const { ref } = await params;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) notFound();
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) notFound();

  const header = (
    <PageHeader
      title={t('partner.customers.conversation.title')}
      sub={t('partner.customers.conversation.sub', { phone: maskPhoneLast4(customer.senderPhone), limit: CONVERSATION_PANEL_LIMIT })}
      actions={
        <Link
          href={`${PARTNER_ROUTES.customers.href}/${ref}`}
          prefetch={false}
          className={buttonVariants({ variant: 'ghost', size: 'md' })}
        >
          {t('partner.customers.conversation.back')}
        </Link>
      }
    />
  );

  let allowed = false;
  try {
    allowed = await takeRevealBudget(getRedis(), ctx.partnerId, ctx.username);
  } catch (err) {
    logWarn('partner.customers.conversation', errName(err), { partnerId: ctx.partnerId });
  }
  if (!allowed) {
    return (
      <>
        {header}
        <p role="status" data-conversation-busy="" className="text-[15px] text-ds-ink-muted">
          {t('partner.customers.conversation.busy')}
        </p>
      </>
    );
  }

  // Not caught: a failed audit write fails the page (no text without a record).
  const entries = (await viewConversation(getDb(), ctx.staff, customer, { actorScope: 'partner' })) ?? [];

  return (
    <>
      {header}
      {entries.length === 0 ? (
        <EmptyState title={t('partner.customers.conversation.empty')} />
      ) : (
        <Card as="section" className="p-5 sm:p-6">
          <p className="mb-4 text-[13px] text-ds-ink-muted">{t('partner.customers.conversation.recorded')}</p>
          <ul className="flex flex-col gap-2 text-[14.5px]" data-testid="partner-conversation">
            {entries.map((m) => (
              <li
                key={m.id}
                data-direction={m.direction}
                className={`max-w-[85%] rounded-ds-inner border border-ds-border px-3 py-2 ${m.direction === 'out' ? 'ml-auto bg-ds-ground' : 'bg-ds-surface'}`}
              >
                <div className="mb-1 text-[12.5px] text-ds-ink-muted tabular-nums">
                  {m.direction === 'in' ? t('partner.customers.conversation.customer') : t('partner.customers.conversation.bot')} ·{' '}
                  {m.channel === 'web' ? t('partner.customers.conversation.channel.web') : t('partner.customers.conversation.channel.wa')} ·{' '}
                  {when(m.createdAt)}
                </div>
                <div className={`whitespace-pre-wrap break-words ${m.unreadable ? 'italic text-ds-ink-muted' : 'text-ds-ink'}`}>
                  {m.unreadable ? t('partner.customers.conversation.unreadable') : m.text}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
