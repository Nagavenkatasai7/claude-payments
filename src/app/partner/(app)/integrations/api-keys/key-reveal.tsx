'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog } from '@/components/ds';
import { MAX_KEYS_PER_MODE, type KeyIssueResult } from '@/lib/partner-api-keys-view';
import type { ActionResult } from '../../../action-result';
import { createKeyAction, revokeKeyAction, rotateKeyAction } from './actions';

// The /partner API-key controls (UI redesign M3-14). A new key's plaintext exists ONLY in the
// issuing action's result, held in this component's useActionState state: it is never a prop
// from the server page, never written to localStorage / sessionStorage / the URL, and it is gone
// on reload. The server re-validates everything (mode allowlist, tenant, go-live, cap).

function Submit({ label, pending: pendingLabel, variant = 'primary' }: { label: string; pending: string; variant?: 'primary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="md" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

/** Shows a just-issued key once, with a copy button. */
export function KeyReveal({ plaintext }: { plaintext: string }) {
  const [copy, setCopy] = React.useState<'idle' | 'done' | 'failed'>('idle');
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopy('done');
    } catch {
      setCopy('failed'); // clipboard unavailable: the key is selectable text
    }
  };
  return (
    <div role="status" className="mt-4 rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg p-4" data-testid="partner-key-reveal">
      <p className="text-[15px] font-semibold text-ds-ink">{t('partner.keys.revealTitle')}</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.keys.revealBody')}</p>
      <code className="mt-3 block select-all rounded-ds-inner border border-ds-border bg-ds-surface px-4 py-3 font-mono text-[13.5px] break-all text-ds-ink">
        {plaintext}
      </code>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="md" onClick={onCopy}>
          {t('partner.keys.copy')}
        </Button>
        {copy === 'done' ? <span className="text-[14px] font-semibold text-ds-success-ink">{t('partner.keys.copied')}</span> : null}
        {copy === 'failed' ? <span className="text-[14px] text-ds-danger-ink">{t('partner.keys.copyFailed')}</span> : null}
      </div>
    </div>
  );
}

function IssueOutcome({ result }: { result: KeyIssueResult | null }) {
  if (!result) return null;
  if (result.ok) return <KeyReveal key={result.last4} plaintext={result.plaintext} />;
  return (
    <p role="alert" className="mt-3 text-[14px] font-semibold text-ds-danger-ink">
      {result.error}
    </p>
  );
}

export function CreateKeyForm({ liveAllowed }: { liveAllowed: boolean }) {
  const [result, formAction] = React.useActionState(createKeyAction, null);
  const radio = 'mt-1 size-4 shrink-0 accent-ds-primary';
  return (
    <form action={formAction} className="mt-4 flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-[14px] font-semibold text-ds-ink">{t('partner.keys.mode')}</legend>
        <label className="flex min-h-11 items-start gap-3 text-[14px] text-ds-ink">
          <input type="radio" name="mode" value="test" defaultChecked className={radio} />
          <span>
            <span className="font-semibold">{t('partner.keys.mode.test')}</span>
            <span className="block text-ds-ink-muted">{t('partner.keys.modeHint.test')}</span>
          </span>
        </label>
        <label className={`flex min-h-11 items-start gap-3 text-[14px] ${liveAllowed ? 'text-ds-ink' : 'text-ds-ink-subtle'}`}>
          <input type="radio" name="mode" value="live" disabled={!liveAllowed} className={radio} />
          <span>
            <span className="font-semibold">{t('partner.keys.mode.live')}</span>
            <span className="block text-ds-ink-muted">{liveAllowed ? t('partner.keys.modeHint.live') : t('partner.keys.liveLocked')}</span>
          </span>
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={t('partner.keys.create')} pending={t('partner.keys.creating')} />
        <span className="text-[13.5px] text-ds-ink-muted">{t('partner.keys.capHint', { max: MAX_KEYS_PER_MODE })}</span>
      </div>
      <IssueOutcome result={result} />
    </form>
  );
}

export function RotateKeyForm({ keyId }: { keyId: string }) {
  const [result, formAction] = React.useActionState(rotateKeyAction, null);
  return (
    <form action={formAction} className="flex flex-col">
      <input type="hidden" name="id" value={keyId} />
      <div>
        <Submit label={t('partner.keys.rotate')} pending={t('partner.keys.rotating')} variant="ghost" />
      </div>
      <IssueOutcome result={result} />
    </form>
  );
}

export function RevokeKeyControl({ keyId, last4 }: { keyId: string; last4: string }) {
  const [result, setResult] = React.useState<ActionResult | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="danger" size="md">
            {t('partner.keys.revoke.button')}
          </Button>
        }
        title={t('partner.keys.revoke.title')}
        body={t('partner.keys.revoke.body', { last4 })}
        confirmLabel={t('partner.keys.revoke.confirm')}
        destructive
        requireReason={false}
        action={async (fd) => {
          fd.set('id', keyId);
          setResult(await revokeKeyAction(fd));
        }}
      />
      {result ? (
        result.ok ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.keys.revoked')}
          </p>
        ) : (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {result.error}
          </p>
        )
      ) : null}
    </div>
  );
}
