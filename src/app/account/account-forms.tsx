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
 * Customer-facing account forms (WhatsApp-dark theme, Tailwind utilities). One
 * client island per flow; each uses useActionState exactly like login-form.tsx.
 * Accessibility:
 *  - every input has a <label> wrapping it (programmatic association),
 *  - the form-level error is role="alert" + the field is aria-describedby it,
 *  - inputs are 16px so iOS Safari never auto-zooms on focus,
 *  - the submit CTA is full-width at the bottom (thumb-zone).
 */

// Shared WhatsApp-dark utility recipes (formerly the legacy theme's scoped rules).
const fieldCls = 'mb-4 block';
const fieldLabelCls = 'mb-1.5 block text-[13px] text-[#8696a0]';
// 16px (not 15) so iOS Safari does NOT auto-zoom the viewport on focus —
// mobile Safari zooms whenever a focused input's font-size is < 16px.
const inputCls =
  'w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';
// Single 6-digit code box: centered, wide tracking, numeric keypad on mobile.
const otpInputCls =
  'w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-center text-[22px] tracking-[0.5em] tabular-nums text-[#e9edef]';
const subCls = '-mt-2 mb-5 text-sm leading-normal text-[#8696a0]';
const trustCls = 'mt-1 mb-[18px] text-xs leading-normal text-[#667781]';
const altCls = 'mt-[18px] text-center text-sm leading-normal text-[#8696a0]';
const altLinkCls = 'font-semibold text-[#25d366] no-underline hover:underline';
const buttonCls =
  'w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a] disabled:cursor-default disabled:opacity-60';
const secondaryButtonCls =
  'mt-2.5 w-full cursor-pointer rounded-3xl border border-[#2a3942] bg-transparent p-3 text-[15px] font-bold text-[#8696a0] disabled:cursor-default disabled:opacity-60';

/** Mask a phone to its last 4 digits for display (…2030). */
function maskPhone(phone: string | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p id="acct-form-error" className="mt-1 mb-3.5 text-[13px] leading-[1.4] text-[#f15c6d]" role="alert">
      {error}
    </p>
  );
}

function FormNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <p className="mt-1 mb-3.5 text-[13px] leading-[1.4] text-[#25d366]" role="status">
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
      <label className={fieldCls}>
        <span className={fieldLabelCls}>WhatsApp phone number</span>
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          defaultValue={prefillPhone ?? ''}
          aria-describedby={err ? 'acct-form-error' : undefined}
          placeholder="+1 555 010 2030"
          className={inputCls}
        />
      </label>
      <label className={fieldCls}>
        <span className={fieldLabelCls}>Email</span>
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={inputCls} />
      </label>
      <label className={fieldCls}>
        <span className={fieldLabelCls}>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={64}
          placeholder="At least 8 characters"
          className={inputCls}
        />
      </label>
      <p className={trustCls}>
        Your details are encrypted and used only to verify you. We&rsquo;ll send a 6-digit
        code to your WhatsApp to confirm this number.
      </p>
      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? 'Creating account…' : 'Create account'}
      </button>
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

  if (state?.step === 'otp' && state.phone) {
    return <OtpForm phone={state.phone} pendingToken={state.pendingToken} notice={state.notice} />;
  }

  const err = state?.error;
  return (
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <FormNotice notice={state?.notice} />
      <label className={fieldCls}>
        <span className={fieldLabelCls}>WhatsApp phone number</span>
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder="+1 555 010 2030"
          className={inputCls}
        />
      </label>
      <label className={fieldCls}>
        <span className={fieldLabelCls}>Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={inputCls} />
      </label>
      <p className={trustCls}>
        For your security we&rsquo;ll send a 6-digit code to your WhatsApp before signing you in.
      </p>
      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? 'Checking…' : 'Continue'}
      </button>
      <p className={altCls}>
        New here? <a href="/account/register" className={altLinkCls}>Create an account</a>
      </p>
      <p className={altCls}>
        <a href="/account/reset" className={altLinkCls}>Forgot password?</a>
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
      <p className={subCls}>
        Enter the 6-digit code we sent to your WhatsApp{' '}
        <strong>{maskPhone(phone)}</strong>.
      </p>
      <FormNotice notice={currentNotice} />
      <form
        action={action}
        aria-describedby={err ? 'acct-form-error' : undefined}
      >
        <FormError error={err} />
        <input type="hidden" name="pendingToken" value={currentToken} />
        <label className={fieldCls}>
          <span className={fieldLabelCls}>Verification code</span>
          <input
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
        </label>
        <button type="submit" disabled={pending} className={buttonCls}>
          {pending ? 'Verifying…' : 'Verify'}
        </button>
      </form>
      <form action={resendAction}>
        <input type="hidden" name="pendingToken" value={currentToken} />
        <button type="submit" className={secondaryButtonCls} disabled={resendPending}>
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
    <form action={action} aria-describedby={err ? 'acct-form-error' : undefined}>
      <FormError error={err} />
      <p className={subCls}>
        Enter your WhatsApp number and we&rsquo;ll send a reset code if an account exists.
      </p>
      <label className={fieldCls}>
        <span className={fieldLabelCls}>WhatsApp phone number</span>
        <input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="+1 555 010 2030" className={inputCls} />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? 'Sending…' : 'Send reset code'}
      </button>
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
            Enter the code we sent to <strong>{maskPhone(phone)}</strong> and choose a new password.
          </p>
          <input type="hidden" name="pendingToken" value={currentToken} />
          <label className={fieldCls}>
            <span className={fieldLabelCls}>Verification code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              className={otpInputCls}
              placeholder="••••••"
            />
          </label>
          <label className={fieldCls}>
            <span className={fieldLabelCls}>New password</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={64}
              placeholder="At least 8 characters"
              className={inputCls}
            />
          </label>
          <p className={trustCls}>
            Resetting your password signs you out of all devices. You&rsquo;ll sign in again with the new one.
          </p>
          <button type="submit" disabled={pending} className={buttonCls}>
            {pending ? 'Resetting…' : 'Reset password'}
          </button>
        </>
      ) : (
        <p className={altCls}>
          <a href="/account/login" className={altLinkCls}>Go to sign in</a>
        </p>
      )}
    </form>
  );
}
