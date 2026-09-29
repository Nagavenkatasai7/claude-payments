'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog, Field, Input } from '@/components/ds';
import type { RailSecretKind } from '@/lib/partner-integrations';
import type { RotateSecretResult, TestPingResult } from '@/lib/partner-webhooks-view';
import type { ActionResult } from '../../../action-result';
import { replayDeliveryAction, rotateSecretAction, saveEndpointAction, sendTestAction } from './actions';
import { StepUpPrompt, useStepUpAction } from '../step-up';

// The /partner settlement-webhook controls (UI redesign M3-15a). A rotated secret exists ONLY in the
// rotate action's result, held in this component's state: never a prop from the server page, never
// written to storage or the URL, gone on reload. The server re-validates everything (URL rule,
// SmartRemit-host refusal, kind allowlist, tenant, rate limit). Save, rotate and replay need a
// 15-minute step-up: the step_up_required result shows StepUpPrompt, whose retry re-sends the same
// submission (a rotated secret is then revealed from that one result; ../step-up.tsx).

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
  const flow = useStepUpAction<ActionResult>((fd) => saveEndpointAction(null, fd));
  const result = flow.stepUp ? null : flow.result;
  // Controlled: a function-action form resets after it runs, and the field must keep showing the
  // URL the step-up retry will save. Editing the URL while the prompt is open drops the prompt.
  const [url, setUrl] = React.useState(current ?? '');
  return (
    <div>
      <form action={flow.run} className="mt-4 flex flex-col gap-4">
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
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (flow.stepUp) flow.dismiss();
              }}
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
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
    </div>
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

/**
 * `graceUntil` set ⇒ a previous secret is still accepted: rotating again would retire it at once, so
 * the dialog says so and sends the explicit override flag (endGrace=1). The server re-checks.
 */
export function RotateSecretControl({ kind, graceUntil }: { kind: RailSecretKind; graceUntil: string | null }) {
  const flow = useStepUpAction<RotateSecretResult>((fd) => rotateSecretAction(null, fd));
  const result = flow.stepUp ? null : flow.result;
  return (
    <div className="flex flex-col">
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="md">
              {t(kind === 'signing' ? 'partner.webhooks.rotate.signing' : 'partner.webhooks.rotate.webhook')}
            </Button>
          }
          title={t(graceUntil ? 'partner.webhooks.rotate.endGraceTitle' : 'partner.webhooks.rotate.title')}
          body={graceUntil ? t('partner.webhooks.rotate.endGraceBody', { when: whenUtc(graceUntil) }) : t('partner.webhooks.rotate.body')}
          confirmLabel={t(graceUntil ? 'partner.webhooks.rotate.endGraceConfirm' : 'partner.webhooks.rotate.confirm')}
          destructive={Boolean(graceUntil)}
          requireReason={false}
          action={async (fd) => {
            fd.set('kind', kind);
            if (graceUntil) fd.set('endGrace', '1');
            await flow.run(fd);
          }}
        />
      </div>
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
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

/**
 * M3-15b: Replay one DEAD settlement instruction. The id is the outbox row id; the server resolves it
 * inside the session tenant, re-checks rail type and rate limit, and only re-queues the row.
 */
export function ReplayControl({ id }: { id: number }) {
  const flow = useStepUpAction<ActionResult>((fd) => replayDeliveryAction(null, fd));
  const result = flow.stepUp ? null : flow.result;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {result?.ok ? null : (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="md">
              {t('partner.webhooks.replay')}
            </Button>
          }
          title={t('partner.webhooks.replay.title')}
          body={t('partner.webhooks.replay.body')}
          confirmLabel={t('partner.webhooks.replay')}
          requireReason={false}
          action={async (fd) => {
            fd.set('id', String(id));
            await flow.run(fd);
          }}
        />
      )}
      {flow.stepUp ? <StepUpPrompt stepUp={flow.stepUp} onSubmit={flow.retry} onCancel={flow.dismiss} pending={flow.retrying} /> : null}
      {result ? (
        result.ok ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.webhooks.replay.done')}
          </p>
        ) : (
          <Alert text={result.error} />
        )
      ) : null}
    </div>
  );
}
