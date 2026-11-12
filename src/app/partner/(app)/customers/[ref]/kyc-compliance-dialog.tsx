'use client';

import { t, type MessageKey } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, Field } from '@/components/ds';
import { KYC_DISPOSITIONS, type KycDecision, type KycDisposition } from '@/lib/partner-reviews';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { ActionResult } from '../../../action-result';
import { StepUpPrompt, useStepUpAction } from '../../integrations/step-up';
import { decideKycAction } from './kyc-actions';

// Fix pack 7 T26 (P24): the KYC decision forms for a QUALIFIED compliance user of a partner that
// decides KYC (partnerDecidesKyc). The page renders it only for such a viewer, with the decisions
// partnerKycOfferedDecisions offers; that is UX. decideKycAction re-runs every gate (tenant, the
// compliance user and MFA, the offer, the flag, the disposition and EDD fields, the flag time)
// and the store re-checks the PEP-only flag on the LOCKED row. A PEP-only customer (pepFlag) needs
// a disposition, and an acceptance needs the "EDD completed" tick; the reviewed flag time rides
// hidden. Every decision asks for a fresh step-up (StepUpPrompt retries the SAME submission with
// the secret added). Client-safe imports only: partner-reviews.ts (a client import-chain root),
// never partner-kyc-decision.ts (server-only).

/** The EDD note bound: KYC_EDD_NOTE_MAX of src/lib/partner-kyc-decision.ts (server-only), pinned by a test. */
export const EDD_NOTE_MAX = 280;

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[80px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;
const BOX = 'mt-1 size-4 shrink-0 accent-ds-primary';

type Result = ActionResult | StepUpRequired;

const COPY: Record<KycDecision, { title: MessageKey; confirm: MessageKey; done: MessageKey }> = {
  approve: { title: 'partner.kyc.approve.title', confirm: 'partner.kyc.approve.confirm', done: 'partner.kyc.approve.done' },
  reject: { title: 'partner.kyc.reject.title', confirm: 'partner.kyc.reject.confirm', done: 'partner.kyc.reject.done' },
};

const dispositionsFor = (d: KycDecision): KycDisposition[] =>
  KYC_DISPOSITIONS.filter((x) => (d === 'reject' ? x === 'reject' : x !== 'reject'));

function DecisionForm({
  customerRef,
  decision,
  pepFlag,
  flaggedAt,
}: {
  customerRef: string;
  decision: KycDecision;
  pepFlag: boolean;
  flaggedAt: string;
}) {
  const flow = useStepUpAction<Result>((fd) => decideKycAction(fd));
  const result = flow.stepUp ? null : (flow.result as ActionResult | null);
  const submit = async (formData: FormData) => {
    formData.set('ref', customerRef);
    formData.set('decision', decision);
    await flow.run(formData);
  };
  return (
    <div className="flex flex-col gap-3 rounded-ds-inner border border-ds-border p-4" data-decision={decision}>
      <h4 className="text-[15px] font-semibold text-ds-ink">{t(COPY[decision].title)}</h4>
      <form action={submit} className="flex flex-col gap-3">
        {pepFlag ? (
          <>
            <input type="hidden" name="screeningFlaggedAt" value={flaggedAt} />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[14px] font-semibold text-ds-ink">{t('partner.kyc.dispositionLegend')}</legend>
              {dispositionsFor(decision).map((d) => (
                <label key={d} className="flex items-start gap-2 text-[14px] text-ds-ink">
                  <input type="radio" name="disposition" value={d} required className={BOX} />
                  <span>{t(`partner.kyc.disposition.${d}`)}</span>
                </label>
              ))}
            </fieldset>
            <label className="flex items-start gap-2 text-[14px] text-ds-ink">
              <input type="checkbox" name="eddDone" value="on" className={BOX} />
              <span>{t('partner.kyc.eddDone')}</span>
            </label>
            <Field name="eddNote" label={t('partner.kyc.eddNote')}>
              {(ids) => (
                <textarea id={ids.id} name="eddNote" maxLength={EDD_NOTE_MAX} rows={2} aria-describedby={ids.describedBy} className={TEXTAREA} />
              )}
            </Field>
          </>
        ) : null}
        <Field name="reason" label={t('ds.dialog.reasonLabel')} hint={t('ds.dialog.reasonHint', { min: STAFF_REASON_MIN })}>
          {(ids) => (
            <textarea
              id={ids.id}
              name="reason"
              required
              minLength={STAFF_REASON_MIN}
              maxLength={500}
              rows={3}
              aria-describedby={ids.describedBy}
              className={TEXTAREA}
            />
          )}
        </Field>
        <div>
          <Button type="submit" variant={decision === 'reject' ? 'danger' : 'primary'} size="md">
            {t(COPY[decision].confirm)}
          </Button>
        </div>
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t(COPY[decision].done)}
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

export function KycComplianceDialog({
  customerRef,
  decisions,
  pepFlag,
  flaggedAt,
}: {
  customerRef: string;
  decisions: readonly KycDecision[];
  pepFlag: boolean;
  flaggedAt: string;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="partner-kyc-compliance-dialog">
      {decisions.map((d) => (
        <DecisionForm key={d} customerRef={customerRef} decision={d} pepFlag={pepFlag} flaggedAt={flaggedAt} />
      ))}
    </div>
  );
}
