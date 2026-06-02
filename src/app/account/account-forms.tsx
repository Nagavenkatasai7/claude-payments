'use client';

import { useActionState } from 'react';
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
 * Customer-facing account forms (.payapp dark theme). One client island per
 * flow; each uses useActionState exactly like login-form.tsx. Accessibility:
 *  - every input has a <label> wrapping it (programmatic association),
 *  - the form-level error is role="alert" + the field is aria-describedby it,
 *  - inputs are 16px (inherited) so iOS Safari never auto-zooms on focus,
 *  - the submit CTA is full-width at the bottom (thumb-zone).
 */

/** Mask a phone to its last 4 digits for display (…2030). */
function maskPhone(phone: string | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p id="acct-form-error" className="acct-error" role="alert">
      {error}
    </p>
  );
}

function FormNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <p className="acct-notice" role="status">
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
    <form action={action} className="acct-form" aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <label className="acct-field">
        <span className="acct-label">WhatsApp phone number</span>
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          defaultValue={prefillPhone ?? ''}
          aria-describedby={err ? 'acct-form-error' : undefined}
          placeholder="+1 555 010 2030"
        />
      </label>
      <label className="acct-field">
        <span className="acct-label">Email</span>
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
      </label>
      <label className="acct-field">
        <span className="acct-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={64}
          placeholder="At least 8 characters"
        />
      </label>
      <p className="acct-trust">
        Your details are encrypted and used only to verify you. We&rsquo;ll send a 6-digit
        code to your WhatsApp to confirm this number.
      </p>
      <button type="submit" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </button>
      <p className="acct-alt">
        Already have an account? <a href="/account/login">Sign in</a>
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

  if (state?.step === 'otp' && state.phone) {
    return <OtpForm phone={state.phone} pendingToken={state.pendingToken} notice={state.notice} />;
  }

  const err = state?.error;
  return (
    <form action={action} className="acct-form" aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <FormNotice notice={state?.notice} />
      <label className="acct-field">
        <span className="acct-label">WhatsApp phone number</span>
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="+1 555 010 2030"
        />
      </label>
      <label className="acct-field">
        <span className="acct-label">Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <p className="acct-trust">
        For your security we&rsquo;ll send a 6-digit code to your WhatsApp before signing you in.
      </p>
      <button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Continue'}
      </button>
      <p className="acct-alt">
        New here? <a href="/account/register">Create an account</a>
      </p>
      <p className="acct-alt">
        <a href="/account/reset">Forgot password?</a>
      </p>
    </form>
  );
}

// ── OTP step (shared by register + login) ───────────────────────────────────
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
      <p className="acct-sub">
        Enter the 6-digit code we sent to your WhatsApp{' '}
        <strong>{maskPhone(phone)}</strong>.
      </p>
      <FormNotice notice={currentNotice} />
      <form
        action={action}
        className="acct-form"
        aria-describedby={err ? 'acct-form-error' : undefined}
      >
        <FormError error={err} />
        <input type="hidden" name="pendingToken" value={currentToken} />
        <label className="acct-field">
          <span className="acct-label">Verification code</span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            className="acct-otp-input"
            aria-describedby={err ? 'acct-form-error' : undefined}
            placeholder="••••••"
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </button>
      </form>
      <form action={resendAction}>
        <input type="hidden" name="pendingToken" value={currentToken} />
        <button type="submit" className="pay-secondary" disabled={resendPending}>
          {resendPending ? 'Sending…' : 'Resend code'}
        </button>
      </form>
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
    <form action={action} className="acct-form" aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <p className="acct-sub">
        Enter your WhatsApp number and we&rsquo;ll send a reset code if an account exists.
      </p>
      <label className="acct-field">
        <span className="acct-label">WhatsApp phone number</span>
        <input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="+1 555 010 2030" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send reset code'}
      </button>
      <p className="acct-alt">
        <a href="/account/login">Back to sign in</a>
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
    <form action={action} className="acct-form" aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <FormNotice notice={state?.notice ?? notice} />
      {state?.step !== 'login' ? (
        <>
          <p className="acct-sub">
            Enter the code we sent to <strong>{maskPhone(phone)}</strong> and choose a new password.
          </p>
          <input type="hidden" name="pendingToken" value={currentToken} />
          <label className="acct-field">
            <span className="acct-label">Verification code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              className="acct-otp-input"
              placeholder="••••••"
            />
          </label>
          <label className="acct-field">
            <span className="acct-label">New password</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={64}
              placeholder="At least 8 characters"
            />
          </label>
          <p className="acct-trust">
            Resetting your password signs you out of all devices. You&rsquo;ll sign in again with the new one.
          </p>
          <button type="submit" disabled={pending}>
            {pending ? 'Resetting…' : 'Reset password'}
          </button>
        </>
      ) : (
        <p className="acct-alt">
          <a href="/account/login">Go to sign in</a>
        </p>
      )}
    </form>
  );
}
