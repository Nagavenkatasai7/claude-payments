'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog } from '@/components/ds';
import type { InvoiceControl } from '@/lib/partner-invoices';
import type { ActionResult } from '../../action-result';
import { reissueInvoiceAction, voidInvoiceAction } from './actions';

// The invoice row's Void / Reissue confirm (lost-features A6). The page renders it for admins only
// and only for the control the bill's status allows; the server action re-gates, re-scopes the id
// to the session tenant and re-checks the status. No typed reason, as before (no money moves). The
// result renders OUTSIDE the dialog, because ConfirmDialog closes after the action.

export function InvoiceControls({ id, control }: { id: string; control: InvoiceControl }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const isVoid = control === 'void';
  const action = async (formData: FormData) => {
    formData.set('id', id);
    setResult(await (isVoid ? voidInvoiceAction(formData) : reissueInvoiceAction(formData)));
  };
  return (
    <div className="flex flex-col gap-1.5" data-invoice-control={control}>
      <ConfirmDialog
        trigger={
          <Button type="button" variant={isVoid ? 'danger' : 'ghost'} size="sm">
            {isVoid ? t('partner.invoices.void') : t('partner.invoices.reissue')}
          </Button>
        }
        title={isVoid ? t('partner.invoices.voidTitle') : t('partner.invoices.reissueTitle')}
        body={isVoid ? t('partner.invoices.voidBody') : t('partner.invoices.reissueBody')}
        confirmLabel={isVoid ? t('partner.invoices.voidConfirm') : t('partner.invoices.reissueConfirm')}
        destructive={isVoid}
        requireReason={false}
        action={action}
      />
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[13px] font-semibold text-ds-success-ink">
            {isVoid ? t('partner.invoices.voidDone') : t('partner.invoices.reissueDone')}
          </p>
        ) : null}
        {result && result.ok === false ? (
          <p role="alert" className="text-[13px] font-semibold text-ds-danger-ink">
            {result.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
