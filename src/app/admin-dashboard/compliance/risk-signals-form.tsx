'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { RISK_SIGNALS, type RiskSignal } from '@/lib/risk-signals';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { setRiskSignalsAction, type RiskSignalsActionResult } from './actions';
import { CodeField } from '../partners/live-certification-forms';

// Fix pack 6 T23 (R48, P22): one corridor's pay-step risk-signal setting, platform admins only.
// The action re-gates everything (site host, platform admin, own two-step, forced step-up,
// strict fields). Client-safe imports only (P0 rule 13): RISK_SIGNALS from the pure module,
// the action and its result TYPE; never the Staff type. Inline English, as the other admin forms.

type Result = RiskSignalsActionResult | StepUpRequired | null;

const SIGNAL_LABELS: Record<RiskSignal, string> = {
  first_to_recipient: 'First send to this recipient',
  first_transfer: 'First transfer',
  new_account: 'New account',
  amount_over_threshold: 'Amount at or over the threshold',
  chat_cue: 'Pressure words in the chat',
};

const INPUT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm';

export interface RiskSignalsFormValue {
  enabled: boolean;
  amountUsd: number;
  newAccountHours: number;
  hold: readonly RiskSignal[];
}

function Outcome({ state }: { state: Result }) {
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="text-sm font-semibold text-foreground">
      Saved.
    </p>
  ) : (
    <p role="alert" className="text-sm font-semibold text-destructive">
      {state.error}
    </p>
  );
}

export function RiskSignalsForm({ partnerId, country, value }: { partnerId: string; country: string; value: RiskSignalsFormValue }) {
  const [state, submit, pending] = useActionState<Result, FormData>(setRiskSignalsAction, null);
  const idBase = `risk-signals-${partnerId}-${country}`;
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="risk-signals-form">
      <input type="hidden" name="partnerId" value={partnerId} />
      <input type="hidden" name="country" value={country} />
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${idBase}-enabled`}>
        Risk signals
        <select id={`${idBase}-enabled`} name="enabled" defaultValue={value.enabled ? 'on' : 'off'} className={INPUT_CLASS}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${idBase}-amount`}>
        Amount threshold (USD)
        <input
          id={`${idBase}-amount`}
          name="amountUsd"
          type="number"
          min={1}
          max={10000}
          step="0.01"
          required
          defaultValue={value.amountUsd}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${idBase}-hours`}>
        New account window (hours)
        <input
          id={`${idBase}-hours`}
          name="newAccountHours"
          type="number"
          min={1}
          max={720}
          step={1}
          required
          defaultValue={value.newAccountHours}
          className={INPUT_CLASS}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1 font-medium">Signals that hold the transfer</legend>
        {RISK_SIGNALS.map((s) => (
          <label key={s} className="inline-flex items-center gap-2">
            <input type="checkbox" name="hold" value={s} defaultChecked={value.hold.includes(s)} />
            {SIGNAL_LABELS[s]}
          </label>
        ))}
      </fieldset>
      <CodeField id={`${idBase}-code`} />
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Outcome state={state} />
    </form>
  );
}
