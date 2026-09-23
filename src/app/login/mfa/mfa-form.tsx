'use client';

import { useActionState } from 'react';
import { verifyMfa } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Program-Fix 17b: the sign-in's second step. Only the code is posted; who is
// signing in comes from the httpOnly pending cookie, never from this form.

export function MfaForm() {
  const [error, formAction, pending] = useActionState(verifyMfa, null);
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">Authentication code</Label>
        <Input
          id="mfa-code"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          aria-describedby="mfa-code-hint"
        />
        <p id="mfa-code-hint" className="text-xs text-muted-foreground">
          The 6-digit code from your authenticator app.
        </p>
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Verifying…' : 'Verify'}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
