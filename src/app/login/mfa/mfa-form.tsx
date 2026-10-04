'use client';

import { useActionState } from 'react';
import { verifyMfa } from './actions';
import { Button, Input } from '@/components/ds';

// Program-Fix 17b: the sign-in's second step. Only the code is posted; who is
// signing in comes from the httpOnly pending cookie, never from this form.

export function MfaForm() {
  const [error, formAction, pending] = useActionState(verifyMfa, null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <label htmlFor="mfa-code" className="mb-1.5 block text-[14px] font-semibold text-ds-ink">
          Authentication code
        </label>
        <Input
          id="mfa-code"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          aria-describedby="mfa-code-hint"
          invalid={Boolean(error)}
          className="text-center font-mono text-[20px] tracking-[0.3em]"
        />
        <p id="mfa-code-hint" className="mt-1.5 text-[13px] text-ds-ink-muted">
          The 6-digit code from your authenticator app.
        </p>
      </div>
      {error && (
        <p className="rounded-ds-inner border border-ds-danger-border bg-ds-danger-bg px-3.5 py-2.5 text-[14px] font-semibold text-ds-danger-ink" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="mt-1 w-full">
        {pending ? 'Verifying…' : 'Verify'}
      </Button>
    </form>
  );
}
