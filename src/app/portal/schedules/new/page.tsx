import type { Metadata } from 'next';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { getDb } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { newRequestKey } from '@/lib/portal-request-key';
import { recipientRid } from '@/lib/portal-recipients';
import { countryForPhone } from '@/lib/partner-currency';
import { normalizePhone } from '@/lib/phone';
import { maskAccount } from '@/lib/tools';
import { boundUntrustedText, NAME_MAX } from '@/lib/untrusted-text';
import { MAX_USD, MIN_USD } from '@/lib/fx';
import { DEFAULT_DESTINATION_COUNTRY } from '@/lib/defaults';
import { t } from '@/lib/i18n';
import { buttonVariants, Card, EmptyState, PageHeader } from '@/components/ds';
import { createScheduleAction } from '../actions';
import { ScheduleForm } from '../schedule-form';

export const metadata: Metadata = { title: t('portal.schedules.newTitle') };

/**
 * New scheduled payment (UI redesign M2-10). Step-up on load, so the form is not lost to a later
 * redirect. The recipient list is the customer's live saved recipients in India (schedules are
 * India-only), each addressed by its opaque rid and shown with the masked account only.
 */
export default async function NewSchedulePage() {
  const site = await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/schedules/new');
  const pid = site.partnerId;
  const phone = ctx.session.phone;
  const recipients = (await createRecipientRepo(getDb()).listAllForSender(pid, phone))
    .filter((r) => countryForPhone(normalizePhone(r.recipientPhone)) === DEFAULT_DESTINATION_COUNTRY && r.payoutDestination !== '')
    .map((r) => ({
      rid: recipientRid(pid, phone, r.recipientPhone),
      label: t('portal.schedules.recipientOption', {
        name: boundUntrustedText(r.name, NAME_MAX),
        masked: maskAccount(r.payoutMethod, r.payoutDestination),
      }),
    }));
  const limits = { min: `$${MIN_USD}`, max: `$${MAX_USD.toLocaleString('en-US')}` };

  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <PageHeader title={t('portal.schedules.newTitle')} sub={t('portal.schedules.newSub')} />
      {recipients.length === 0 ? (
        <EmptyState
          icon={<Users className="size-5" />}
          title={t('portal.schedules.noRecipientsTitle')}
          body={t('portal.schedules.noRecipientsBody')}
          action={
            <Link href="/portal/recipients/new" className={buttonVariants({ variant: 'primary', size: 'md' })}>
              {t('portal.schedules.addRecipient')}
            </Link>
          }
        />
      ) : (
        <Card>
          <ScheduleForm action={createScheduleAction} initial={{ requestKey: newRequestKey() }} recipients={recipients} limits={limits} />
        </Card>
      )}
    </div>
  );
}
