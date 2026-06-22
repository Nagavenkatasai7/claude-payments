'use client';

import { useActionState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  registerAction,
  loginAction,
  verifyOtpAction,
  resendOtpAction,
  requestResetAction,
  resetAction,
  type AccountState,
} from './actions';

/**
 * Customer-facing account forms (default LIGHT fintech theme, @/components/ui).
 * One client island per flow; each uses useActionState exactly like before.
 * Accessibility:
 *  - every input has an associated <Label htmlFor> (programmatic association),
 *  - the form-level error is an <Alert role="alert"> + the field is aria-describedby it,
 *  - inputs render at text-base (16px) so iOS Safari never auto-zooms on focus,
 *  - the submit CTA is full-width at the bottom (thumb-zone).
 *
 * Only className/markup changed in this file — every field `name=`, every server
 * action, every step/branch, and the pending/error UI are preserved verbatim.
 */

// Single 6-digit code box: centered, wide tracking, numeric keypad on mobile.
// 16px+ so mobile Safari does NOT auto-zoom the viewport on focus. The explicit
// `md:text-2xl` overrides the Input base's `md:text-sm` (twMerge treats the
// responsive variant as a separate group — without it the box shrinks to 14px
// on desktop and the wide tracking looks broken).
const otpInputCls = 'h-12 text-center text-2xl md:text-2xl tracking-[0.5em] tabular-nums';
const subCls = 'mb-5 text-sm leading-normal text-muted-foreground';
const trustCls = 'mb-4 text-xs leading-normal text-muted-foreground';
const altCls = 'mt-4 text-center text-sm leading-normal text-muted-foreground';
const altLinkCls = 'font-medium text-primary hover:underline';

/** Mask a phone to its last 4 digits for display (…2030). */
function maskPhone(phone: string | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <Alert id="acct-form-error" variant="destructive" className="mb-4">
      <AlertDescription className="text-destructive">{error}</AlertDescription>
    </Alert>
  );
}

function FormNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <p className="mb-4 text-sm leading-snug text-primary" role="status">
      {notice}
    </p>
  );
}

// ── Register ──────────────────────────────────────────────────────────────
export function RegisterForm({ token, prefillPhone }: { token?: string; prefillPhone?: string }) {
  const [state, action, pending] = useActionState<AccountState | null, FormData>(
    registerAction,
    null,
  );

  // Once the action advances to the OTP step, swap to the OTP island.
  if (state?.step === 'otp' && state.phone) {
    return <OtpForm phone={state.phone} pendingToken={state.pendingToken} notice={state.notice} />;
  }

  const err = state?.error;
  return (
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="register-phone">WhatsApp phone number</Label>
        <Input
          id="register-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          defaultValue={prefillPhone ?? ''}
          aria-describedby={err ? 'acct-form-error' : undefined}
          placeholder="+1 555 010 2030"
        />
      </div>
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="register-email">Email</Label>
        <Input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
        />
      </div>
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="register-password">Password</Label>
        <Input
          id="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={64}
          placeholder="At least 8 characters"
        />
      </div>
      <p className={trustCls}>
        Your details are encrypted and used only to verify you. We&rsquo;ll send a 6-digit
        code to your WhatsApp to confirm this number.
      </p>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
      <p className={altCls}>
        Already have an account? <a href="/account/login" className={altLinkCls}>Sign in</a>
      </p>
    </form>
  );
}

// ── Login ─────────────────────────────────────────────────────────────────
export function LoginForm() {
  const [state, action, pending] = useActionState<AccountState | null, FormData>(
    loginAction,
    null,
  );
  // Login is password-only for VERIFIED accounts (server-redirects to
  // /account). The OTP step below renders only for an account that never
  // completed its registration code — finishing the phone binding, not a
  // login factor (see loginAction's binding gate).
  if (state?.step === 'otp' && state.phone) {
    return <OtpForm phone={state.phone} pendingToken={state.pendingToken} notice={state.notice} />;
  }

  const err = state?.error;
  return (
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <FormNotice notice={state?.notice} />
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="login-phone">WhatsApp phone number</Label>
        <Input
          id="login-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="+1 555 010 2030"
        />
      </div>
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <p className={trustCls}>
        Sign in with your phone number and password.
      </p>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className={altCls}>
        New here? <a href="/account/register" className={altLinkCls}>Create an account</a>
      </p>
      <p className={altCls}>
        <a href="/account/reset" className={altLinkCls}>Forgot password?</a>
      </p>
    </form>
  );
}

// ── OTP step (register + reset confirm — login is password-only) ───────────
function OtpForm({
  phone,
  pendingToken,
  notice,
}: {
  phone: string;
  pendingToken?: string;
  notice?: string;
}) {
  const [state, action, pending] = useActionState<AccountState | null, FormData>(
    verifyOtpAction,
    null,
  );
  const [resendState, resendAction, resendPending] = useActionState<AccountState | null, FormData>(
    resendOtpAction,
    null,
  );

  const err = state?.error;
  const currentNotice = resendState?.notice ?? state?.notice ?? notice;
  // Carry the latest pending-auth token through verify/resend round-trips; the
  // server derives the phone from it (the form phone is display-only).
  const currentToken = state?.pendingToken ?? resendState?.pendingToken ?? pendingToken ?? '';
  return (
    <div>
      <p className={subCls}>
        Enter the 6-digit code we sent to your WhatsApp{' '}
        <strong className="text-foreground">{maskPhone(phone)}</strong>.
      </p>
      <FormNotice notice={currentNotice} />
      <form
        action={action}
        aria-describedby={err ? 'acct-form-error' : undefined}
      >
        <FormError error={err} />
        <input type="hidden" name="pendingToken" value={currentToken} />
        <div className="mb-4 grid gap-1.5">
          <Label htmlFor="otp-code">Verification code</Label>
          <Input
            id="otp-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            className={otpInputCls}
            aria-describedby={err ? 'acct-form-error' : undefined}
            placeholder="••••••"
          />
        </div>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <form action={resendAction}>
        <input type="hidden" name="pendingToken" value={currentToken} />
        <Button type="submit" variant="outline" className="mt-2.5 w-full" disabled={resendPending}>
          {resendPending ? 'Sending…' : 'Resend code'}
        </Button>
      </form>
      {/* Shown UNCONDITIONALLY (enumeration-safe — reveals nothing about the
          account): until the Meta AUTHENTICATION template is approved, codes
          are free-form WhatsApp texts, which Meta only delivers within 24h of
          the customer's last message to the bot. The self-service fix is to
          message the bot first, then resend. */}
      <p className="mt-4 text-xs leading-normal text-muted-foreground">
        Didn&rsquo;t get a code? WhatsApp only lets us message you within 24 hours
        of your last chat with us. Send <strong>hi</strong> to our WhatsApp
        number first, then tap <strong>Resend code</strong>.
      </p>
    </div>
  );
}

// ── Reset (request → confirm) ───────────────────────────────────────────────
export function ResetForm() {
  const [state, action, pending] = useActionState<AccountState | null, FormData>(
    requestResetAction,
    null,
  );

  // Once a code is dispatched, show the confirm step.
  if (state?.step === 'otp' && state.phone) {
    return <ResetConfirmForm phone={state.phone} pendingToken={state.pendingToken} notice={state.notice} />;
  }

  const err = state?.error;
  return (
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <p className={subCls}>
        Enter your WhatsApp number and we&rsquo;ll send a reset code if an account exists.
      </p>
      <div className="mb-4 grid gap-1.5">
        <Label htmlFor="reset-phone">WhatsApp phone number</Label>
        <Input
          id="reset-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="+1 555 010 2030"
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Send reset code'}
      </Button>
      <p className={altCls}>
        <a href="/account/login" className={altLinkCls}>Back to sign in</a>
      </p>
    </form>
  );
}

function ResetConfirmForm({
  phone,
  pendingToken,
  notice,
}: {
  phone: string;
  pendingToken?: string;
  notice?: string;
}) {
  const [state, action, pending] = useActionState<AccountState | null, FormData>(
    resetAction,
    null,
  );

  // On success the action returns step:'login' with a notice — show it inline.
  const err = state?.error;
  const currentToken = state?.pendingToken ?? pendingToken ?? '';
  return (
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <FormNotice notice={state?.notice ?? notice} />
      {state?.step !== 'login' ? (
        <>
          <p className={subCls}>
            Enter the code we sent to <strong className="text-foreground">{maskPhone(phone)}</strong> and choose a new password.
          </p>
          <input type="hidden" name="pendingToken" value={currentToken} />
          <div className="mb-4 grid gap-1.5">
            <Label htmlFor="reset-code">Verification code</Label>
            <Input
              id="reset-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              className={otpInputCls}
              placeholder="••••••"
            />
          </div>
          <div className="mb-4 grid gap-1.5">
            <Label htmlFor="reset-new-password">New password</Label>
            <Input
              id="reset-new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={64}
              placeholder="At least 8 characters"
            />
          </div>
          <p className={trustCls}>
            Resetting your password signs you out of all devices. You&rsquo;ll sign in again with the new one.
          </p>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Resetting…' : 'Reset password'}
          </Button>
        </>
      ) : (
        <p className={altCls}>
          <a href="/account/login" className={altLinkCls}>Go to sign in</a>
        </p>
      )}
    </form>
  );
}
