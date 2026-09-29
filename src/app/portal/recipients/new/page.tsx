import type { Metadata } from 'next';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { newRequestKey } from '@/lib/portal-request-key';
import { RECIPIENT_COUNTRIES } from '@/lib/portal-recipients';
import { t } from '@/lib/i18n';
import { Card, PageHeader } from '@/components/ds';
import { addRecipientAction } from '../actions';
import { RecipientForm } from '../recipient-form';

export const metadata: Metadata = { title: t('portal.recipients.newTitle') };

const regionName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Add a recipient (UI redesign M2-8). Step-up on load, so the form is not lost to a later redirect. */
export default async function NewRecipientPage() {
  await requirePortalSite();
  await requireFreshPortalAuth('/portal/recipients/new');
  const countries = RECIPIENT_COUNTRIES.map((code) => ({ code, name: regionName(code) })).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <PageHeader title={t('portal.recipients.newTitle')} sub={t('portal.recipients.newSub')} />
      <Card>
        <RecipientForm mode="add" action={addRecipientAction} initial={{ requestKey: newRequestKey() }} countries={countries} />
      </Card>
    </div>
  );
}
