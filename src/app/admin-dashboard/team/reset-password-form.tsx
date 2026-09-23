'use client';

import { useActionState } from 'react';
import { resetStaffPasswordAction } from './actions';
import { Button } from '@/components/ui/button';

// Program-Fix 17a: a platform admin sets a new password for a teammate. The
// field is `newPassword` (never `password`) and the button text avoids the
// smoke's /^remove$/ and /create teammate/ locators.

export function ResetPasswordForm({ username, name }: { username: string; name: string }) {
  const [state, formAction, pending] = useActionState(resetStaffPasswordAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="username" value={username} />
      <input
        name="newPassword"
        type="password"
        required
        minLength={12}
        maxLength={128}
        autoComplete="new-password"
        placeholder="New password"
        aria-label={`New password for ${name}`}
        className="h-8 w-36 rounded-md border border-input bg-card px-2 text-xs"
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Setting…' : 'Set password'}
      </Button>
      {state && (
        <span className={`text-xs ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`} role={state.ok ? 'status' : 'alert'}>
          {state.message}
        </span>
      )}
    </form>
  );
}
