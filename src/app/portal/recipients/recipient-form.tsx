'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { BANK_FIELDS_BY_COUNTRY, accountConfirmKey, accountConfirmLabel } from '@/lib/payout-format';
import { t } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import type { CountryCode } from '@/lib/types';
import type { RecipientFormState } from './actions';

// The add / edit recipient form (UI redesign M2-8). Bank fields come from the pay page's own
// definitions (payout-format), so the server validator and the inputs never disagree. Bank values
// are never echoed back after an error, and the edit form never pre-fills the account: blank keeps it.

// -webkit-text-security works in every current browser (Firefox from 114, MDN browser-compat-data)
// and, unlike type="password", keeps the numeric keypad and stays out of the password manager.
const HIDDEN_TEXT = '[-webkit-text-security:disc]';

type Props =
  | {
      mode: 'add';
      action: (prev: RecipientFormState, fd: FormData) => Promise<RecipientFormState>;
      initial: RecipientFormState;
      countries: Array<{ code: CountryCode; name: string }>;
    }
  | {
      mode: 'edit';
      action: (prev: RecipientFormState, fd: FormData) => Promise<RecipientFormState>;
      initial: RecipientFormState;
      name: string;
      /** The stored recipient's bank country; null = the account cannot be changed here. */
      country: CountryCode | null;
    };

export function RecipientForm(props: Props) {
  const [state, action, busy] = useActionState(props.action, props.initial);
  const [country, setCountry] = useState<CountryCode | null>(
    props.mode === 'edit' ? props.country : ((state.values?.country as CountryCode | undefined) ?? 'IN'),
  );
  // Raj (Oct 7): the account number is typed hidden, with Show / Hide and a re-enter box.
  const [showAccount, setShowAccount] = useState(false);
  const e = state.errors ?? {};
  const bankFields = country ? (BANK_FIELDS_BY_COUNTRY[country] ?? []) : [];
  const nameDefault = state.values?.name ?? (props.mode === 'edit' ? props.name : '');

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="requestKey" value={state.requestKey} />
      {state.error ? (
        <p role="alert" className="rounded-ds-inner border border-ds-danger-ink/30 bg-ds-danger-bg px-4 py-3 text-[14px] font-semibold text-ds-danger-ink">
          {t(state.error)}
        </p>
      ) : null}
      <Field name="name" label={t('portal.recipients.nameLabel')} error={e.name ? t(e.name) : undefined} required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} name="name" key={`name-${state.requestKey}`} defaultValue={nameDefault} maxLength={80} autoComplete="off"
            required aria-describedby={describedBy} invalid={invalid} />
        )}
      </Field>
      {props.mode === 'add' ? (
        <>
          <Field name="recipientPhone" label={t('portal.recipients.phoneLabel')} hint={t('portal.recipients.phoneHint')}
            error={e.recipientPhone ? t(e.recipientPhone) : undefined} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} name="recipientPhone" key={`rp-${state.requestKey}`} type="tel" inputMode="tel" autoComplete="off"
                defaultValue={state.values?.recipientPhone ?? ''} maxLength={32} required aria-describedby={describedBy} invalid={invalid} />
            )}
          </Field>
          <Field name="country" label={t('portal.recipients.countryLabel')} error={e.country ? t(e.country) : undefined} required>
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="country" value={country ?? ''} onChange={(ev) => setCountry(ev.target.value as CountryCode)}
                aria-describedby={describedBy} invalid={invalid}>
                {props.countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
        </>
      ) : null}
      {bankFields.length > 0 ? (
        <fieldset className="flex flex-col gap-4 rounded-ds-card border border-ds-border p-4 sm:p-5">
          <legend className="px-1 text-[15px] font-semibold text-ds-ink">{t('portal.recipients.bankHeading')}</legend>
          {props.mode === 'edit' ? <p className="text-[13px] text-ds-ink-muted">{t('portal.recipients.bankEditHint')}</p> : null}
          {bankFields.map((f) => {
            const box = (
              <Field key={`${country}-${f.key}`} name={f.key} label={f.label} error={e.bank?.[f.key]} required={props.mode === 'add'}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} name={f.key} key={`${f.key}-${state.requestKey}`} autoComplete="off" spellCheck={false} maxLength={64}
                    inputMode={f.pattern ? 'text' : 'numeric'} aria-describedby={describedBy} invalid={invalid}
                    className={f.isAccount && !showAccount ? HIDDEN_TEXT : undefined} />
                )}
              </Field>
            );
            if (!f.isAccount) return box;
            const confirmKey = accountConfirmKey(f.key);
            return (
              <div key={`${country}-${f.key}`} className="flex flex-col gap-4">
                {box}
                <Field name={confirmKey} label={accountConfirmLabel(f.label)} error={e.bank?.[confirmKey]} required={props.mode === 'add'}>
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} name={confirmKey} key={`${confirmKey}-${state.requestKey}`} autoComplete="off" spellCheck={false} maxLength={64}
                      inputMode={f.pattern ? 'text' : 'numeric'} aria-describedby={describedBy} invalid={invalid}
                      className={showAccount ? undefined : HIDDEN_TEXT} />
                  )}
                </Field>
                <button type="button" onClick={() => setShowAccount((v) => !v)} aria-pressed={showAccount}
                  aria-label={`${showAccount ? t('portal.recipients.hideAccount') : t('portal.recipients.showAccount')} ${f.label}`}
                  className="self-start text-[13px] font-semibold text-ds-primary underline-offset-2 hover:underline focus-visible:underline">
                  {showAccount ? t('portal.recipients.hideAccount') : t('portal.recipients.showAccount')}
                </button>
              </div>
            );
          })}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? t('portal.recipients.saving') : t('portal.recipients.save')}
        </Button>
        <Link href="/portal/recipients" className="text-[14px] font-semibold text-ds-primary">
          {t('portal.recipients.back')}
        </Link>
      </div>
    </form>
  );
}
