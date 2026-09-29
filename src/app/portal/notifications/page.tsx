import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { getPortalPrefs, verifiedReceiptEmail } from '@/lib/portal-prefs';
import { openCustomerEmail, recordPortalPiiView } from '@/lib/portal-profile';
import { maskEmail } from '@/lib/portal-email-verify';
import { newRequestKey } from '@/lib/portal-request-key';
import { t } from '@/lib/i18n';
import { Badge, Card, PageHeader } from '@/components/ds';
import { EmailForm, ReceiptsToggleForm, WhatsappToggleForm } from './notification-forms';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.notify.title', { referrer: 'no-referrer' });

/**
 * Notifications (UI redesign M2-11, Tasks 11.3-11.4): WhatsApp updates on/off (the bot's STOP/START),
 * the email address with its verify link, and email receipts (only once the CURRENT address is
 * verified). The address is shown masked; a render that shows it writes one `pii.view` row.
 */
export default async function NotificationsPage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const db = getDb();
  const owner = { partnerId: site.partnerId, senderPhone: ctx.session.phone, email: ctx.customer.email };
  const [prefs, verified] = await Promise.all([getPortalPrefs(db, site.partnerId, ctx.session.phone), verifiedReceiptEmail(db, owner)]);
  const email = openCustomerEmail(ctx.customer);
  if (email) await recordPortalPiiView(db, site.partnerId, ctx.session.phone, ['email'], 'portal.notifications');
  const waOn = !ctx.customer.optedOutAt;

  return (
    <>
      <PageHeader title={t('portal.notify.title')} sub={t('portal.notify.sub', { brand: site.brand })} />
      <div className="flex flex-col gap-5">
        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.notify.wa_title')}</h2>
            <Badge tone={waOn ? 'success' : 'neutral'}>{t(waOn ? 'portal.notify.state_on' : 'portal.notify.state_off')}</Badge>
          </div>
          <p className="text-[14px] text-ds-ink-muted">{t('portal.notify.wa_body', { brand: site.brand })}</p>
          <p className="text-[13px] text-ds-ink-muted">{t('portal.notify.wa_essential')}</p>
          <WhatsappToggleForm on={waOn} />
        </Card>

        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.email.title')}</h2>
            {email ? (
              <Badge tone={verified ? 'success' : 'warning'}>{t(verified ? 'portal.email.state_verified' : 'portal.email.state_unverified')}</Badge>
            ) : null}
          </div>
          <p className="text-[14.5px] text-ds-ink">
            {email ? <span className="font-mono">{maskEmail(email)}</span> : <span className="text-ds-ink-muted">{t('portal.email.none')}</span>}
          </p>
          {email && !verified ? <p className="text-[13px] text-ds-ink-muted">{t('portal.email.check_inbox')}</p> : null}
          <EmailForm requestKey={newRequestKey()} hasEmail={Boolean(email)} />
        </Card>

        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
          <h2 className="text-[17px] font-bold text-ds-ink">{t('portal.notify.receipts_title')}</h2>
          <p className="text-[14px] text-ds-ink-muted">{t('portal.notify.receipts_body')}</p>
          {verified ? (
            <ReceiptsToggleForm on={Boolean(prefs?.emailReceipts)} />
          ) : (
            <p className="text-[13px] text-ds-ink-muted">{t('portal.notify.receipts_needs_email')}</p>
          )}
        </Card>
      </div>
    </>
  );
}
