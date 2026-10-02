'use client';

import { useState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, ConfirmDialog } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { decideKycAction } from './kyc-actions';

// The KYC decision dialogs (merge plan 2c, D3). The page renders this only for a PARTNER_ADMIN and
// only with the decisions partnerKycDecision allows; that is UX. The server action re-gates,
// re-scopes the opaque ref to the session tenant, re-checks the reason and the rule, and the
// writer re-checks the screening flags on the locked row, so nothing here is trusted.

type Decision = 'approve' | 'reject';
const COPY: Record<Decision, { trigger: MessageKey; title: MessageKey; body: MessageKey; confirm: MessageKey; done: MessageKey }> = {
  approve: {
    trigger: 'partner.kyc.approve.trigger',
    title: 'partner.kyc.approve.title',
    body: 'partner.kyc.approve.body',
    confirm: 'partner.kyc.approve.confirm',
    done: 'partner.kyc.approve.done',
  },
  reject: {
    trigger: 'partner.kyc.reject.trigger',
    title: 'partner.kyc.reject.title',
    body: 'partner.kyc.reject.body',
    confirm: 'partner.kyc.reject.confirm',
    done: 'partner.kyc.reject.done',
  },
};

export function KycDecisionDialog({ customerRef, decisions }: { customerRef: string; decisions: readonly Decision[] }) {
  const [result, setResult] = useState<{ decision: Decision; r: ActionResult } | null>(null);
  const run = (decision: Decision) => async (formData: FormData) => {
    formData.set('ref', customerRef);
    formData.set('decision', decision);
    setResult({ decision, r: await decideKycAction(formData) });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="partner-kyc-decision-dialog">
      <div className="flex flex-wrap gap-3">
        {decisions.map((d) => (
          <ConfirmDialog
            key={d}
            trigger={
              <Button type="button" variant={d === 'reject' ? 'danger' : 'primary'} size="md">
                {t(COPY[d].trigger)}
              </Button>
            }
            title={t(COPY[d].title)}
            body={t(COPY[d].body)}
            confirmLabel={t(COPY[d].confirm)}
            reasonMin={STAFF_REASON_MIN}
            destructive={d === 'reject'}
            action={run(d)}
          />
        ))}
      </div>
      <div aria-live="polite">
        {result?.r.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t(COPY[result.decision].done)}
          </p>
        ) : null}
        {result && result.r.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {result.r.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
