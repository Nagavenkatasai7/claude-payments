'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { CodeField } from '../../partners/live-certification-forms';
import type { MhaListActionResult } from './actions';
import { mhaCodeCopy } from './copy';

// Fix pack 5 T31 (R08, P28): the India MHA upload and "confirm still current" forms. Rendered only
// for a platform admin; the actions re-gate everything. Both always ask for the authenticator code
// (the step-up is always required). A refusal lists row numbers and codes, never a value from the
// file.

type Action = (formData: FormData) => Promise<MhaListActionResult>;
type Result = MhaListActionResult | null;

const OUTCOME_KEY = {
  activated: 'admin.compliance.sanctionsLists.outcome.activated',
  unchanged: 'admin.compliance.sanctionsLists.outcome.unchanged',
  confirmed: 'admin.compliance.sanctionsLists.outcome.confirmed',
} as const;

function Outcome({ state }: { state: Result }) {
  if (!state) return null;
  if (state.ok) {
    return (
      <p role="status" className="text-sm font-semibold text-foreground">
        {t(OUTCOME_KEY[state.outcome])}
      </p>
    );
  }
  const rows = 'rows' in state ? state.rows : undefined;
  return (
    <div role="alert" className="flex flex-col gap-1.5 text-sm">
      <p className="font-semibold text-destructive">{state.error}</p>
      {rows && rows.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground" data-testid="mha-row-errors">
          {rows.map((r, i) => (
            <li key={`${r.row}-${r.code}-${i}`}>
              {t('admin.compliance.sanctionsLists.row', { row: r.row })}: {mhaCodeCopy(r.code)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useListAction(action: Action) {
  return useActionState<Result, FormData>((_prev, fd) => action(fd), null);
}

export function MhaUploadForm({ action }: { action: Action }) {
  const [state, submit, pending] = useListAction(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="mha-upload-form">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('admin.compliance.sanctionsLists.upload.file')}
        <Input name="file" type="file" accept=".csv,text/csv" required />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('admin.compliance.sanctionsLists.upload.version')}
        <Input name="version" type="date" required />
      </label>
      <CodeField id="mha-upload-code" />
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('admin.compliance.sanctionsLists.pending') : t('admin.compliance.sanctionsLists.upload.submit')}
        </Button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

export function MhaConfirmForm({ action }: { action: Action }) {
  const [state, submit, pending] = useListAction(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="mha-confirm-form">
      <CodeField id="mha-confirm-code" />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? t('admin.compliance.sanctionsLists.pending') : t('admin.compliance.sanctionsLists.confirm.submit')}
        </Button>
      </div>
      <Outcome state={state} />
    </form>
  );
}
