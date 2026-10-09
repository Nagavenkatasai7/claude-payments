import { TriangleAlert } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Checkbox } from '@/components/ds';

// Batch B follow-up A4: the scam warning shown before the money goes when the customer's reason
// matches a scam pattern (the server decides; the page is never told which words matched). The
// "I have read this warning" tick is required: the server refuses the send without it. Plain markup:
// rendered by server pages and client forms alike.
export function ScamWarning({ error }: { error?: string }) {
  return (
    <div data-scam-warning="" role="alert" className="flex flex-col gap-2 rounded-ds-card border border-ds-warning-border bg-ds-warning-bg p-4 text-ds-warning-ink">
      <p className="flex items-start gap-2 text-[14px] font-semibold">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <span>{t('portal.send.scamWarning')}</span>
      </p>
      <Checkbox name="scam_ack" label={t('portal.send.scamAck')} required error={error} />
    </div>
  );
}
