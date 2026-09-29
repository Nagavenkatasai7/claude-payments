'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, ConfirmDialog } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { releaseHoldAction } from './release-actions';

// The hold-release dialog (UI redesign M3-10). The page renders it only for a PARTNER_ADMIN on a
// hold isPartnerReleasableHold accepts; that is UX. The server action re-gates, re-scopes the id to
// the session tenant, re-checks the reason (same minimum) and the predicate, so nothing here is
// trusted. The result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

export function ReleaseDialog({ id }: { id: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const action = async (formData: FormData) => {
    formData.set('id', id);
    setResult(await releaseHoldAction(formData));
  };
  return (
    <div className="flex flex-col gap-3" data-testid="partner-release">
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" size="md">
              {t('partner.release.trigger')}
            </Button>
          }
          title={t('partner.release.title')}
          body={t('partner.release.body')}
          confirmLabel={t('partner.release.confirm')}
          reasonMin={STAFF_REASON_MIN}
          action={action}
        />
      </div>
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.release.released')}
          </p>
        ) : null}
        {result && result.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {result.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
