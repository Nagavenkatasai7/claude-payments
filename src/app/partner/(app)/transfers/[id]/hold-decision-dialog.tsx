'use client';

import { t } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { Button, Field } from '@/components/ds';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { HoldDecisionResult } from './hold-decision-actions';
import { StepUpPrompt, useStepUpAction } from '../../integrations/step-up';

// Fix pack 7 T12 (P15): one hold class's decision form on /partner/transfers/[id]. The page renders
// it only for a qualified compliance user of a hold-queue partner, one per partner-decided OPEN class;
// that is UX. The action (decideHoldAction, bound to the route id ON THE SERVER, so the route param
// stays authoritative) re-runs every gate: tenant, compliance user, MFA, the class, the disposition,
// the reason, the row fingerprint and the four-eyes step, under the row lock. Props only: no runtime
// import of the action module or hold-queue.ts (types only). A final step asks for a fresh step-up
// (StepUpPrompt retries the SAME submission with the secret added). The result renders outside the
// form with role status / alert.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[96px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle ${FOCUS}`;
const RADIO = 'mt-1 size-4 shrink-0 accent-ds-primary';

type Result = HoldDecisionResult | StepUpRequired;

const OUTCOME_KEY = {
  recorded: 'partner.holdDecision.recorded',
  awaiting_second: 'partner.holdDecision.awaitingSecond',
  released: 'partner.holdDecision.released',
  rejected: 'partner.holdDecision.rejected',
} as const;

export interface HoldDecisionOption {
  value: string;
  label: string;
  releases: boolean;
}

export function HoldDecisionDialog({
  action,
  holdClass,
  classLabel,
  dispositions,
  rowFp,
  screeningFlaggedAt,
  fourEyes,
  mode,
}: {
  action: (prev: unknown, fd: FormData) => Promise<Result>;
  holdClass: string;
  classLabel: string;
  dispositions: HoldDecisionOption[];
  rowFp: string;
  /** sender_pep only: the flag time the page read ('' = no time on file); null = not sent. */
  screeningFlaggedAt: string | null;
  fourEyes: boolean;
  mode: 'first' | 'second';
}) {
  const flow = useStepUpAction<Result>((fd) => action(null, fd));
  const result = flow.stepUp ? null : (flow.result as HoldDecisionResult | null);
  const submit = async (formData: FormData) => {
    await flow.run(formData);
  };
  const release = dispositions.filter((d) => d.releases);
  const reject = dispositions.filter((d) => !d.releases);
  const radio = (d: HoldDecisionOption) => (
    <label key={d.value} className="flex items-start gap-2 text-[14px] text-ds-ink">
      <input type="radio" name="disposition" value={d.value} required className={RADIO} />
      <span>{d.label}</span>
    </label>
  );
  return (
    <div className="flex flex-col gap-3 rounded-ds-inner border border-ds-border p-4" data-testid="partner-hold-decision" data-class={holdClass}>
      <h3 className="text-[15px] font-semibold text-ds-ink">
        {t('partner.holdDecision.title')}: {classLabel}
      </h3>
      {mode === 'second' ? <p className="text-[13.5px] text-ds-ink-muted">{t('partner.holdDecision.secondReview')}</p> : null}
      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="holdClass" value={holdClass} />
        <input type="hidden" name="rowFp" value={rowFp} />
        {screeningFlaggedAt !== null ? <input type="hidden" name="screeningFlaggedAt" value={screeningFlaggedAt} /> : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{classLabel}</legend>
          {release.map(radio)}
          {fourEyes && mode === 'first' && release.length > 0 ? (
            <p className="pl-6 text-[13px] text-ds-ink-muted">{t('partner.holdDecision.fourEyesNote')}</p>
          ) : null}
          {reject.map(radio)}
        </fieldset>
        <Field name="reason" label={t('partner.holdDecision.reason')}>
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
          <Button type="submit" size="md">
            {t('partner.holdDecision.submit')}
          </Button>
        </div>
      </form>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      <div aria-live="polite">
        {result?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t(OUTCOME_KEY[result.outcome])}
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
