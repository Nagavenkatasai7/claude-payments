'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Checkbox, Field, Input, Select } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { savePartnerRewardAction } from './actions';

// The /partner/rewards forms (B3 rewards v1). Plain forms: nothing here is trusted. The server
// action re-gates, takes the tenant from the session and checks every value against the admin
// catalog; the client attributes (min, max, pattern) are conveniences only. Errors are the
// server's fixed copy.

function Status({ state }: { state: ActionResult | null }) {
  return (
    <div aria-live="polite">
      {state?.ok === true ? (
        <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
          {t('partner.rewards.saved')}
        </p>
      ) : null}
      {state && state.ok === false ? (
        <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function SaveButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" size="md" disabled={pending}>
      {pending ? t('partner.rewards.saving') : t('partner.rewards.save')}
    </Button>
  );
}

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return savePartnerRewardAction(formData);
}

export function NthRewardForm({ enabled, nth, min, max }: { enabled: boolean; nth: number | null; min: number; max: number }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="rewards-nth-form">
      <input type="hidden" name="kind" value="nth_transfer" />
      <Checkbox name="enabled" label={t('partner.rewards.enabled')} defaultChecked={enabled} />
      <Field name="nth" label={t('partner.rewards.nth.n', { min, max })}>
        {(ids) => (
          <Input id={ids.id} name="nth" type="number" inputMode="numeric" min={min} max={max} step={1}
            defaultValue={nth ?? min} aria-describedby={ids.describedBy} className="max-w-[8rem]" />
        )}
      </Field>
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={state} />
    </form>
  );
}

export interface FestivalValues {
  enabled: boolean;
  festivalName: string;
  startsOn: string;
  endsOn: string;
  minAmountUsd: string;
}

export function FestivalRewardForm({ current, names }: { current: FestivalValues; names: string[] }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="rewards-festival-form">
      <input type="hidden" name="kind" value="festival" />
      <Checkbox name="enabled" label={t('partner.rewards.enabled')} defaultChecked={current.enabled} />
      <Field name="festivalName" label={t('partner.rewards.festival.name')}>
        {(ids) => (
          <Select id={ids.id} name="festivalName" defaultValue={names.includes(current.festivalName) ? current.festivalName : ''}
            aria-describedby={ids.describedBy}>
            <option value="">{t('partner.rewards.festival.choose')}</option>
            {names.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="startsOn" label={t('partner.rewards.festival.starts')}>
          {(ids) => <Input id={ids.id} name="startsOn" type="date" defaultValue={current.startsOn} aria-describedby={ids.describedBy} />}
        </Field>
        <Field name="endsOn" label={t('partner.rewards.festival.ends')}>
          {(ids) => <Input id={ids.id} name="endsOn" type="date" defaultValue={current.endsOn} aria-describedby={ids.describedBy} />}
        </Field>
      </div>
      <Field name="minAmountUsd" label={t('partner.rewards.festival.min')}>
        {(ids) => (
          <Input id={ids.id} name="minAmountUsd" type="text" inputMode="decimal" pattern="\d{1,6}(\.\d{1,2})?"
            defaultValue={current.minAmountUsd} aria-describedby={ids.describedBy} className="max-w-[10rem]" />
        )}
      </Field>
      <div>
        <SaveButton pending={pending} />
      </div>
      <Status state={state} />
    </form>
  );
}
