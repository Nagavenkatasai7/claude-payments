import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_ROUTES } from '../../../routes';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { newRequestKey } from '@/lib/portal-request-key';
import { contactAvailable, errName, listContactThreads, tenantStaffUsernames } from '@/lib/partner-tickets';
import { Card, EmptyState, PageHeader } from '@/components/ds';
import type { Ticket } from '@/lib/types';
import { BackLink, LoadError, TicketRows, formatWhen } from '../support-bits';
import { ContactForm } from './contact-form';

export const metadata: Metadata = { title: t('partner.contact.title'), robots: { index: false, follow: false } };

// /partner/support/contact (UI redesign M3-19): the SESSION tenant's threads with the SmartRemit
// team (internal tickets, answered from the platform employee-questions queue). A partner admin
// sees the tenant's threads; everyone else sees only the ones they started. Never another tenant's.

export default async function PartnerContactPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.supportContact.policy);

  let rows: Ticket[] | null = null;
  let named = new Set<string>();
  try {
    rows = await listContactThreads(ctx);
    named = await tenantStaffUsernames(
      ctx.partnerId,
      rows.map((r) => r.openedBy ?? ''),
      (u) => getAuthStore().getStaff(u),
    );
  } catch (err) {
    logWarn('partner.support.contact_list', errName(err), { partnerId: ctx.partnerId });
    rows = null;
  }
  const opener = (r: Ticket) =>
    r.openedBy === ctx.username
      ? t('partner.support.from.you')
      : r.openedBy && named.has(r.openedBy)
        ? r.openedBy
        : t('partner.support.from.platform');

  return (
    <>
      <BackLink href={PARTNER_ROUTES.support.href} label={t('partner.support.back')} />
      <PageHeader title={t('partner.contact.title')} sub={t('partner.contact.sub')} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
        <section aria-labelledby="contact-list-title" className="order-2 lg:order-1">
          <h2 id="contact-list-title" className="mb-3 text-[17px] font-semibold text-ds-ink">
            {ctx.role === 'admin' ? t('partner.contact.listTitleAdmin') : t('partner.contact.listTitle')}
          </h2>
          {rows === null ? (
            <LoadError message={t('partner.contact.loadError')} />
          ) : rows.length === 0 ? (
            <EmptyState title={t('partner.contact.emptyTitle')} body={t('partner.contact.emptyBody')} />
          ) : (
            <TicketRows
              rows={rows}
              meta={(r) => [
                t('partner.contact.openedBy', { name: opener(r) }),
                t('partner.support.updated', { when: formatWhen(r.updatedAt) }),
              ]}
            />
          )}
        </section>
        <Card as="section" className="order-1 p-4 sm:p-6 lg:order-2">
          <h2 className="mb-4 text-[17px] font-semibold text-ds-ink">{t('partner.contact.newTitle')}</h2>
          {contactAvailable(ctx.partnerId) ? (
            <ContactForm requestKey={newRequestKey()} />
          ) : (
            <p className="text-[15px] text-ds-ink-muted">{t('partner.contact.unavailable')}</p>
          )}
        </Card>
      </div>
    </>
  );
}
