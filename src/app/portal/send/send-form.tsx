'use client';

import { useActionState, useState } from 'react';
import { t, type MessageKey } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ds';
import { PURPOSE_LABELS, TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import { startSendReviewAction, type SendFormState } from './actions';
import { SendAlert } from './kyc-card';

// The Send form (UI redesign M2-9). Amount, currency, destination, how the customer pays, and the
// recipient: a saved one (by its opaque rid, account masked) or someone new (name + phone only; the
// bank details are entered on the pay page, as today), then why the customer is sending (required).
// The server re-validates every field.

export interface SendFormProps {
  currencies: string[];
  destinations: Array<{ code: string; name: string }>;
  funding: Array<{ value: string; label: MessageKey }>;
  saved: Array<{ rid: string; name: string; masked: string }>;
  initial: { amount: string; currency: string; destination: string; funding: string; recipient: string; name?: string; phone?: string; purpose?: string };
}

export function SendForm({ currencies, destinations, funding, saved, initial }: SendFormProps) {
  const [state, action, busy] = useActionState(startSendReviewAction, {} satisfies SendFormState);
  const v = { ...initial, ...(state.values ?? {}) };
  const [recipient, setRecipient] = useState<string>(v.recipient || (saved[0]?.rid ?? 'new'));
  const e = state.errors ?? {};
  const err = (k: keyof typeof e) => (e[k] ? t(e[k]!) : undefined);

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {state.error ? <SendAlert message={t(state.error)} /> : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field name="amount" label={t('portal.send.amountLabel')} error={err('amount')} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} name="amount" inputMode="decimal" autoComplete="off" defaultValue={v.amount} maxLength={12}
              required aria-describedby={describedBy} invalid={invalid} />
          )}
        </Field>
        {currencies.length > 1 ? (
          <Field name="currency" label={t('portal.send.currencyLabel')} error={err('currency')} required>
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="currency" defaultValue={v.currency || currencies[0]} aria-describedby={describedBy} invalid={invalid}>
                {currencies.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <input type="hidden" name="currency" value={currencies[0] ?? ''} />
        )}
      </div>
      <Field name="destination" label={t('portal.send.destinationLabel')} error={err('destination')} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="destination" defaultValue={v.destination || 'IN'} aria-describedby={describedBy} invalid={invalid}>
            {destinations.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field name="funding" label={t('portal.send.fundingLabel')} error={err('funding')} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="funding" defaultValue={v.funding || funding[0]?.value} aria-describedby={describedBy} invalid={invalid}>
            {funding.map((f) => (
              <option key={f.value} value={f.value}>{t(f.label)}</option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-ds-card border border-ds-border p-4 sm:p-5">
        <legend className="px-1 text-[15px] font-semibold text-ds-ink">{t('portal.send.recipientLabel')}</legend>
        {saved.map((r) => (
          <label key={r.rid} className="flex min-w-0 items-center gap-3 text-[14.5px] text-ds-ink">
            <input type="radio" name="recipient" value={r.rid} checked={recipient === r.rid} onChange={() => setRecipient(r.rid)}
              className="size-4 shrink-0 accent-ds-primary" />
            <span className="min-w-0 break-words">
              <span className="font-semibold">{r.name}</span> <span className="font-mono text-ds-ink-muted">{r.masked}</span>
            </span>
          </label>
        ))}
        <label className="flex items-center gap-3 text-[14.5px] text-ds-ink">
          <input type="radio" name="recipient" value="new" checked={recipient === 'new'} onChange={() => setRecipient('new')}
            className="size-4 shrink-0 accent-ds-primary" />
          <span className="font-semibold">{t('portal.send.recipientNew')}</span>
        </label>
        {e.recipient ? <p className="text-[13.5px] font-semibold text-ds-danger-ink">{t(e.recipient)}</p> : null}
        {recipient === 'new' ? (
          <div className="flex flex-col gap-4 pt-1">
            <Field name="name" label={t('portal.send.nameLabel')} error={err('name')} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} name="name" defaultValue={v.name ?? ''} maxLength={80} autoComplete="off" required
                  aria-describedby={describedBy} invalid={invalid} />
              )}
            </Field>
            <Field name="phone" label={t('portal.send.phoneLabel')} hint={t('portal.send.phoneHint')} error={err('phone')} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} name="phone" type="tel" inputMode="tel" autoComplete="off" defaultValue={v.phone ?? ''} maxLength={32}
                  required aria-describedby={describedBy} invalid={invalid} />
              )}
            </Field>
          </div>
        ) : null}
      </fieldset>

      {/* Required purpose (owner decision 2026-10-08): one of the 8, no default (the customer chooses). */}
      <Field name="purpose" label={t('portal.send.purposeLabel')} error={err('purpose')} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="purpose" defaultValue={v.purpose ?? ''} required aria-describedby={describedBy} invalid={invalid}>
            <option value="" disabled>{t('portal.send.purposePlaceholder')}</option>
            {TRANSFER_PURPOSES.map((p) => (
              <option key={p} value={p}>{PURPOSE_LABELS[p]}</option>
            ))}
          </Select>
        )}
      </Field>

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? t('portal.send.reviewing') : t('portal.send.review')}
        </Button>
      </div>
    </form>
  );
}
