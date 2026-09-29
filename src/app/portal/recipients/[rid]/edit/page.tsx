import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { newRequestKey } from '@/lib/portal-request-key';
import { findByRid, isRid, RECIPIENT_COUNTRIES } from '@/lib/portal-recipients';
import { maskAccount } from '@/lib/tools';
import { countryForPhone } from '@/lib/partner-currency';
import { normalizePhone } from '@/lib/phone';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { editRecipientAction } from '../../actions';
import { RecipientForm } from '../../recipient-form';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.recipients.editTitle');

/**
 * Edit a saved recipient (UI redesign M2-8). The rid resolves only inside (host partner, session
 * phone); anything else is the portal 404. The account is shown masked and never pre-filled.
 */
export default async function EditRecipientPage({ params }: { params: Promise<{ rid: string }> }) {
  await requirePortalSite();
  const { rid } = await params;
  const ctx = await requireFreshPortalAuth(isRid(rid) ? `/portal/recipients/${rid}/edit` : '/portal/recipients');
  const recipient = await findByRid(getDb(), ctx.site.partnerId, ctx.session.phone, rid);
  if (!recipient) notFound();
  const cc = countryForPhone(normalizePhone(recipient.recipientPhone));
  const country = cc && RECIPIENT_COUNTRIES.includes(cc) ? cc : null;
  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <PageHeader
        title={t('portal.recipients.editTitle')}
        sub={t('portal.recipients.editSub', { masked: maskAccount(recipient.payoutMethod, recipient.payoutDestination) })}
      />
      <Card>
        <RecipientForm mode="edit" action={editRecipientAction.bind(null, rid)} initial={{ requestKey: newRequestKey() }}
          name={recipient.name} country={country} />
      </Card>
    </div>
  );
}
