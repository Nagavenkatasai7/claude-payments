'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button, Field, Input } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { claimSlugAction } from './slug-actions';

// The one-time web-address claim (UI redesign M3-18). Nothing here is trusted: the server action
// re-gates, takes the tenant from the session, throttles, validates and re-checks claim-once inside
// the writer's transaction. `pattern` / `maxLength` are conveniences only; errors are the server's copy.

async function submitClaim(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return claimSlugAction(formData);
}

export function SlugClaimForm() {
  const [state, formAction, pending] = useActionState(submitClaim, null);
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="branding-slug-form">
      <Field name="slug" label={t('partner.slug.label')} hint={t('partner.slug.hint')}>
        {(ids) => (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              id={ids.id}
              name="slug"
              aria-describedby={ids.describedBy}
              invalid={ids.invalid}
              required
              minLength={3}
              maxLength={30}
              pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{1,28}[a-zA-Z0-9]"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono"
            />
            <span className="font-mono text-[14px] text-ds-ink-muted">.smartremit.ai</span>
          </div>
        )}
      </Field>
      <div>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? t('partner.slug.claiming') : t('partner.slug.claim')}
        </Button>
      </div>
      <div aria-live="polite">
        {state?.ok === true ? (
          <p role="status" className="text-[14px] font-semibold text-ds-success-ink">
            {t('partner.slug.claimed')}
          </p>
        ) : null}
        {state && state.ok === false ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
