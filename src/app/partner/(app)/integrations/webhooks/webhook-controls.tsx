'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog, Field, Input } from '@/components/ds';
import type { RailSecretKind } from '@/lib/partner-integrations';
import type { RotateSecretResult, TestPingResult } from '@/lib/partner-webhooks-view';
import type { ActionResult } from '../../../action-result';
import { rotateSecretAction, saveEndpointAction, sendTestAction } from './actions';

// The /partner settlement-webhook controls (UI redesign M3-15a). A rotated secret exists ONLY in the
// rotate action's result, held in this component's state: never a prop from the server page, never
// written to storage or the URL, gone on reload. The server re-validates everything (URL rule,
// SmartRemit-host refusal, kind allowlist, tenant, rate limit).

const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function Submit({ label, pending: pendingLabel, variant = 'primary' }: { label: string; pending: string; variant?: 'primary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="md" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function Alert({ text }: { text: string }) {
  return (
    <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
      {text}
    </p>
  );
}

export function EndpointForm({ current }: { current: string | null }) {
  const [result, formAction] = React.useActionState(saveEndpointAction, null as ActionResult | null);
  return (
    <form action={formAction} className="mt-4 flex flex-col gap-4">
      <Field name="url" label={t('partner.webhooks.endpointLabel')} hint={t('partner.webhooks.endpointHint')}>
        {(ids) => (
          <Input
            id={ids.id}
            aria-describedby={ids.describedBy}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={2048}
            defaultValue={current ?? ''}
            placeholder="https://"
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={t('partner.webhooks.save')} pending={t('partner.webhooks.saving')} />
        {result ? (
          result.ok ? (
            <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
              {t('partner.webhooks.saved')}
            </p>
          ) : (
            <Alert text={result.error} />
          )
        ) : null}
      </div>
    </form>
  );
}

function SecretReveal({ secret, graceUntil }: { secret: string; graceUntil: string | null }) {
  const [copy, setCopy] = React.useState<'idle' | 'done' | 'failed'>('idle');
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('done');
    } catch {
      setCopy('failed'); // clipboard unavailable: the secret is selectable text
    }
  };
  return (
    <div role="status" className="mt-3 rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg p-4" data-testid="partner-secret-reveal">
      <p className="text-[15px] font-semibold text-ds-ink">{t('partner.webhooks.reveal.title')}</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.reveal.body')}</p>
      {graceUntil ? <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.reveal.grace', { when: whenUtc(graceUntil) })}</p> : null}
      <code className="mt-3 block select-all rounded-ds-inner border border-ds-border bg-ds-surface px-4 py-3 font-mono text-[13.5px] break-all text-ds-ink">
        {secret}
      </code>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="md" onClick={onCopy}>
          {t('partner.webhooks.copy')}
        </Button>
        {copy === 'done' ? <span className="text-[14px] font-semibold text-ds-success-ink">{t('partner.webhooks.copied')}</span> : null}
        {copy === 'failed' ? <span className="text-[14px] text-ds-danger-ink">{t('partner.webhooks.copyFailed')}</span> : null}
      </div>
    </div>
  );
}

export function RotateSecretControl({ kind }: { kind: RailSecretKind }) {
  const [result, setResult] = React.useState<RotateSecretResult | null>(null);
  return (
    <div className="flex flex-col">
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="md">
              {t(kind === 'signing' ? 'partner.webhooks.rotate.signing' : 'partner.webhooks.rotate.webhook')}
            </Button>
          }
          title={t('partner.webhooks.rotate.title')}
          body={t('partner.webhooks.rotate.body')}
          confirmLabel={t('partner.webhooks.rotate.confirm')}
          requireReason={false}
          action={async (fd) => {
            fd.set('kind', kind);
            setResult(await rotateSecretAction(null, fd));
          }}
        />
      </div>
      {result ? result.ok ? <SecretReveal key={result.secret.slice(-8)} secret={result.secret} graceUntil={result.graceUntil} /> : <div className="mt-3"><Alert text={result.error} /></div> : null}
    </div>
  );
}

function pingMessage(r: Extract<TestPingResult, { ok: true }>): string {
  switch (r.outcome) {
    case 'ok':
      return t('partner.webhooks.test.ok', { status: r.httpStatus ?? 0, ms: r.latencyMs });
    case 'http_error':
      return t('partner.webhooks.test.http_error', { status: r.httpStatus ?? 0 });
    case 'network':
      return t('partner.webhooks.test.network');
    default:
      return t('partner.webhooks.test.refused');
  }
}

export function TestEventForm() {
  const [result, formAction] = React.useActionState(sendTestAction, null as TestPingResult | null);
  return (
    <form action={formAction} className="mt-4 flex flex-wrap items-center gap-3">
      <Submit label={t('partner.webhooks.test')} pending={t('partner.webhooks.testing')} variant="ghost" />
      {result ? (
        result.ok ? (
          <p role="status" className={`text-[14px] font-semibold ${result.outcome === 'ok' ? 'text-ds-success-ink' : 'text-ds-danger-ink'}`}>
            {pingMessage(result)}
          </p>
        ) : (
          <Alert text={result.error} />
        )
      ) : null}
    </form>
  );
}
