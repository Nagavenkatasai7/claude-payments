'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { amlRuleKey } from '@/lib/partner-reviews';
import { Button } from '@/components/ds';
import type { AmlExplainFacts } from '@/lib/aml-explain-ai';
import { explainAmlAction, type AmlExplainActionResult } from './explain-actions';

// The partner-side AML "Explain" (A4; owner D5: rendered for admins only, and the action re-gates).
// READ-ONLY. The facts list is rendered from the server's D5 partner bundle (the rule label, never a
// count, sum, window or threshold) and never from model text; the narrative below it is labelled
// "AI explanation — you decide", or "AI unavailable — standard explanation" for the fallback.

async function submit(_prev: AmlExplainActionResult | null, formData: FormData): Promise<AmlExplainActionResult | null> {
  return explainAmlAction(formData);
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function Facts({ facts }: { facts: AmlExplainFacts }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13.5px]" aria-label={t('partner.amlExplain.factsCaption')}>
      <dt className="text-ds-ink-muted">{t('partner.amlExplain.rule')}</dt>
      <dd className="text-ds-ink">
        {facts.rules.length === 0
          ? t('partner.amlExplain.noRule')
          : facts.rules.map((r) => `${t(amlRuleKey(r.rule))}${r.source === 'recomputed' ? ` ${t('partner.amlExplain.recomputed')}` : ''}`).join(' · ')}
      </dd>
      <dt className="text-ds-ink-muted">{t('partner.amlExplain.amount')}</dt>
      <dd className="tabular-nums text-ds-ink">{usd(facts.amountUsd)}</dd>
      <dt className="text-ds-ink-muted">{t('partner.amlExplain.corridor')}</dt>
      <dd className="text-ds-ink">{facts.sourceCountry} → {facts.destinationCountry}</dd>
      <dt className="text-ds-ink-muted">{t('partner.amlExplain.onHold')}</dt>
      <dd className="text-ds-ink">
        {facts.onHold ? t('partner.amlExplain.onHoldHours', { hours: facts.holdAgeHours ?? 0 }) : t('partner.amlExplain.no')}
      </dd>
      <dt className="text-ds-ink-muted">{t('partner.amlExplain.edd')}</dt>
      <dd className="text-ds-ink">{t(facts.eddRequired ? 'partner.amlExplain.yes' : 'partner.amlExplain.no')}</dd>
    </dl>
  );
}

export function PartnerAmlExplain({ transferId }: { transferId: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <div className="flex flex-col gap-3" data-testid="partner-aml-explain">
      <form action={formAction}>
        <input type="hidden" name="id" value={transferId} />
        <Button type="submit" size="sm" variant="ghost" disabled={pending}>
          {pending ? t('partner.amlExplain.loading') : t('partner.amlExplain.button')}
        </Button>
      </form>
      {state && state.ok === false ? (
        <p role="alert" className="text-[13.5px] font-semibold text-ds-danger-ink">{state.error}</p>
      ) : null}
      {state && state.ok === true ? (
        <div className="flex flex-col gap-3 rounded-ds-inner border border-ds-border bg-ds-ground p-4">
          <Facts facts={state.facts} />
          <div className="border-t border-ds-border pt-3">
            <p className="text-[12.5px] font-semibold text-ds-ink-muted">
              {t(state.source === 'ai' ? 'partner.amlExplain.ai' : 'partner.amlExplain.fallback')}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-[14px] text-ds-ink">{state.explanation.summary}</p>
            {state.explanation.checks.length > 0 ? (
              <>
                <p className="mt-2 text-[12.5px] font-semibold text-ds-ink-muted">{t('partner.amlExplain.checks')}</p>
                <ul className="mt-1 list-disc pl-5 text-[14px] text-ds-ink">
                  {state.explanation.checks.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </>
            ) : null}
            <p className="mt-2 text-[13.5px] text-ds-ink">
              <span className="text-ds-ink-muted">{t('partner.amlExplain.next')}: </span>
              {t(`partner.amlExplain.next.${state.explanation.next_step}`)}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
