'use client';

import { useActionState } from 'react';
import {
  beginCustomerMfaEnrolmentAction,
  confirmCustomerMfaEnrolmentAction,
  type CustomerMfaEnrolState,
} from './mfa-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Program-Fix 49D (portal-03): set up TOTP two-step verification for the
// customer portal, mirroring 17b's staff form. Step 1 re-proves the current
// password and asks the server for a fresh secret (shown here once, never
// stored by the page); step 2 confirms it with one code from the
// authenticator app before it is turned on.

const INITIAL: CustomerMfaEnrolState = { ok: false };

/** "ABCD EFGH …" for manual entry. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

export function CustomerMfaEnrolForm() {
  const [begun, beginAction, beginning] = useActionState(beginCustomerMfaEnrolmentAction, INITIAL);
  const [confirmed, confirmAction, confirming] = useActionState(confirmCustomerMfaEnrolmentAction, INITIAL);

  if (confirmed.ok) {
    return (
      <p className="text-sm" role="status">
        {confirmed.message}
      </p>
    );
  }

  return (
    <div className="max-w-md space-y-4">
      <form action={beginAction} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="cust-mfa-password">Current password</Label>
          <Input
            id="cust-mfa-password"
            name="currentPassword"
            type="password"
            required
            autoComplete="current-password"
            className="max-w-sm"
          />
        </div>
        <Button type="submit" variant={begun.ok ? 'outline' : 'default'} disabled={beginning}>
          {beginning ? 'Preparing…' : begun.ok ? 'Start again with a new key' : 'Set up two-step verification'}
        </Button>
        {!begun.ok && begun.message && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {begun.message}
          </p>
        )}
      </form>

      {begun.ok && begun.secret && (
        <>
          <div className="space-y-1.5 text-sm">
            <p>
              In your authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password),
              add an account with this setup key (time-based, 6 digits). It is shown only now and expires in 10
              minutes.
            </p>
            <p className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider break-all" aria-label="Setup key">
              {grouped(begun.secret)}
            </p>
            {begun.uri && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Setup link (otpauth://) for apps that accept one</summary>
                <p className="mt-1 font-mono break-all">{begun.uri}</p>
              </details>
            )}
          </div>
          <form action={confirmAction} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cust-mfa-code">Code from the app</Label>
              <Input
                id="cust-mfa-code"
                name="code"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                className="max-w-40"
              />
            </div>
            <Button type="submit" disabled={confirming}>
              {confirming ? 'Checking…' : 'Turn on'}
            </Button>
            {!confirmed.ok && confirmed.message && (
              <p className="text-sm text-destructive" role="alert">
                {confirmed.message}
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );
}
