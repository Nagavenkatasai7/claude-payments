'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { Field, Select } from '@/components/ds';
import { PURPOSE_LABELS, TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import { dsCn } from '@/lib/ui/ds-cn';

// The required purpose select plus, when the customer chooses Other, "Tell us the reason" (Batch B
// follow-up A3). Shared by Send, Send again and the schedule form. The server is the authority (it
// re-checks the reason and may turn it into one of the 8 purposes); this only shows the box.
// No import of purpose-detail.ts here: it is server-side (its text normaliser pulls node modules),
// so the limit is repeated as a plain number (PURPOSE_DETAIL_MAX, 120).
const PURPOSE_DETAIL_MAX_LENGTH = 120;

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const TEXTAREA = `min-h-[88px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle aria-[invalid=true]:border-ds-danger-ink ${FOCUS}`;

export function PurposeFields({
  purpose,
  purposeDetail,
  purposeError,
  detailError,
  label = t('portal.send.purposeLabel'),
  placeholder = t('portal.send.purposePlaceholder'),
}: {
  /** The starting choice ('' for none). */
  purpose?: string;
  /** The starting reason (shown only while Other is chosen). */
  purposeDetail?: string;
  purposeError?: string;
  detailError?: string;
  label?: string;
  placeholder?: string;
}) {
  const [chosen, setChosen] = useState(purpose ?? '');
  return (
    <>
      <Field name="purpose" label={label} error={purposeError} required>
        {({ id, describedBy, invalid }) => (
          <Select id={id} name="purpose" defaultValue={purpose ?? ''} required aria-describedby={describedBy} invalid={invalid}
            onChange={(e) => setChosen(e.currentTarget.value)}>
            <option value="" disabled>{placeholder}</option>
            {TRANSFER_PURPOSES.map((p) => (
              <option key={p} value={p}>{PURPOSE_LABELS[p]}</option>
            ))}
          </Select>
        )}
      </Field>
      {chosen === 'other' ? (
        <Field name="purpose_detail" label={t('portal.send.purposeDetailLabel')} hint={t('portal.send.purposeDetailHint')} error={detailError} required>
          {({ id, describedBy, invalid }) => (
            <textarea id={id} name="purpose_detail" defaultValue={purposeDetail ?? ''} maxLength={PURPOSE_DETAIL_MAX_LENGTH} rows={2}
              required autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid || undefined} className={dsCn(TEXTAREA)} />
          )}
        </Field>
      ) : null}
    </>
  );
}
