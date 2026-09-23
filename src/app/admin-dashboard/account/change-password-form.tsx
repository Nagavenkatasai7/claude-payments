'use client';

import { useActionState } from 'react';
import { changeOwnPasswordAction } from '../team/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Program-Fix 17a: change your own staff password. The action returns a
// { ok, message } state, so every refusal (wrong current password, policy,
// throttle, a concurrent change) is shown here, never swallowed.

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, null);
  return (
    <form action={formAction} className="max-w-sm space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="acct-current">Current password</Label>
        <Input id="acct-current" name="currentPassword" type="password" required autoComplete="current-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="acct-new">New password</Label>
        <Input
          id="acct-new"
          name="newPassword"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          aria-describedby="acct-new-hint"
        />
        <p id="acct-new-hint" className="text-xs text-muted-foreground">
          12 to 128 characters. Passwords found in known data breaches are refused.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="acct-confirm">Confirm new password</Label>
        <Input
          id="acct-confirm"
          name="confirmPassword"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Changing…' : 'Change password'}
      </Button>
      {state && (
        <p className={`text-sm ${state.ok ? 'text-foreground' : 'text-destructive'}`} role={state.ok ? 'status' : 'alert'}>
          {state.message}
        </p>
      )}
    </form>
  );
}
