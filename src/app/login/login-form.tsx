'use client';

import { useActionState } from 'react';
import { login } from './actions';
import { Button, Input } from '@/components/ds';

// The e2e smoke drives this form via getByLabel(/username/i & /password/i)
// and the /sign in/i button — keep the label associations and texts intact.

const LABEL = 'mb-1.5 block text-[14px] font-semibold text-ds-ink';

export function LoginForm() {
  const [error, formAction, pending] = useActionState(login, null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <label htmlFor="login-username" className={LABEL}>
          Username
        </label>
        <Input id="login-username" name="username" required autoComplete="username" invalid={Boolean(error)} />
      </div>
      <div>
        <label htmlFor="login-password" className={LABEL}>
          Password
        </label>
        <Input
          id="login-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          invalid={Boolean(error)}
        />
      </div>
      {error && (
        <p className="rounded-ds-inner border border-ds-danger-border bg-ds-danger-bg px-3.5 py-2.5 text-[14px] font-semibold text-ds-danger-ink" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="mt-1 w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
