'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../../action-result';
import { disconnectWhatsappAction, saveWhatsappAction, testWhatsappAction } from './actions';

// The /partner WhatsApp controls (UI redesign M3-13). They receive NO stored value: every secret
// field renders empty (write-only; blank keeps the stored value), and the phone number id is not
// pre-filled either (the page shows only its last 4). The server re-validates everything.

function Submit({ label, pending: pendingLabel, variant = 'primary' }: { label: string; pending: string; variant?: 'primary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="md" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function Outcome({ result, okText }: { result: ActionResult | null; okText: string }) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
      {okText}
    </p>
  ) : (
    <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
      {result.error}
    </p>
  );
}

const run = (action: (fd: FormData) => Promise<ActionResult>) => async (_prev: ActionResult | null, fd: FormData) => action(fd);

export function WhatsappConfigForm() {
  const [result, formAction] = React.useActionState(run(saveWhatsappAction), null);
  const secret = { type: 'password', autoComplete: 'off', spellCheck: false, maxLength: 1024 } as const;
  return (
    <form action={formAction} className="mt-4 grid gap-4 md:grid-cols-2">
      <Field name="phoneNumberId" label={t('partner.whatsapp.field.pnid')} hint={t('partner.whatsapp.field.pnidHint')}>
        {(ids) => (
          <Input id={ids.id} aria-describedby={ids.describedBy} name="phoneNumberId" inputMode="numeric" autoComplete="off" pattern="\d{5,20}" maxLength={20} />
        )}
      </Field>
      <Field name="wabaId" label={t('partner.whatsapp.field.waba')} hint={t('partner.whatsapp.field.wabaHint')}>
        {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} name="wabaId" inputMode="numeric" autoComplete="off" pattern="\d{1,30}" maxLength={30} />}
      </Field>
      <Field name="token" label={t('partner.whatsapp.field.token')} hint={t('partner.whatsapp.field.secretHint')}>
        {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} name="token" {...secret} />}
      </Field>
      <Field name="appSecret" label={t('partner.whatsapp.field.appSecret')} hint={t('partner.whatsapp.field.secretHint')}>
        {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} name="appSecret" {...secret} />}
      </Field>
      <Field name="verifyToken" label={t('partner.whatsapp.field.verifyToken')} hint={t('partner.whatsapp.field.secretHint')}>
        {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} name="verifyToken" {...secret} />}
      </Field>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <Submit label={t('partner.whatsapp.save')} pending={t('partner.whatsapp.saving')} />
        <Outcome result={result} okText={t('partner.whatsapp.saved')} />
      </div>
    </form>
  );
}

export function TestConnectionForm() {
  const [result, formAction] = React.useActionState(run(testWhatsappAction), null);
  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-3">
      <Submit label={t('partner.whatsapp.test.run')} pending={t('partner.whatsapp.test.running')} variant="ghost" />
      <Outcome result={result} okText={t('partner.whatsapp.test.done')} />
    </form>
  );
}

export function DisconnectControl() {
  const [result, setResult] = React.useState<ActionResult | null>(null);
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-ds-border pt-4">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="danger" size="md">
            {t('partner.whatsapp.disconnect.button')}
          </Button>
        }
        title={t('partner.whatsapp.disconnect.title')}
        body={t('partner.whatsapp.disconnect.body')}
        confirmLabel={t('partner.whatsapp.disconnect.confirm')}
        destructive
        requireReason={false}
        action={async (fd) => setResult(await disconnectWhatsappAction(fd))}
      />
      <Outcome result={result} okText={t('partner.whatsapp.disconnected')} />
    </div>
  );
}
