'use client';

import { useState, type FormEvent } from 'react';
import type { CountryCode } from '@/lib/types';
import {
  BANK_FIELDS_BY_COUNTRY,
  composePayoutDestination,
  maskAccountDisplay,
  validatePayoutFields,
  type Field,
} from '@/lib/payout-format';

type Status = 'idle' | 'paying' | 'done' | 'error';
type Step = 'details' | 'review';

export interface PaySummary {
  destAmount: number;
  destCurrency: string;
  sourceAmount: number;
  sourceCurrency: string;
  sourceTotalCharge: number;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ── Tailwind conversion of the legacy WhatsApp-dark theme (legacy-themes.css) ─
// Exact visual identity. `leading-normal` pins line-height to the inherited
// 1.5 the legacy CSS relied on (named text-* utilities would otherwise set
// their own). Input font-size is 16px (NOT 15) so iOS Safari does not
// auto-zoom the viewport on focus — Safari zooms whenever a focused input's
// font-size is < 16px.
const inputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';
// Single 6-digit code box: centered, wide tracking, 22px digits.
const otpInputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-center text-[22px] tracking-[0.5em] text-[#e9edef] tabular-nums';
const labelClasses = 'mb-3 block text-[13px] text-[#8696a0]';
const primaryBtnClasses =
  'w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a] disabled:cursor-default disabled:opacity-60';
const secondaryBtnClasses =
  'mt-2.5 w-full cursor-pointer rounded-3xl border border-[#2a3942] bg-transparent p-3 text-[15px] font-bold text-[#8696a0] disabled:cursor-default disabled:opacity-60';
const stepLabelClasses = 'mb-3.5 text-xs leading-normal uppercase tracking-[0.04em] text-[#8696a0]';
const fieldErrorClasses = 'mt-1 block text-xs leading-normal text-[#f15c6d]';
const formErrorClasses = 'mt-2 text-[13px] text-[#f15c6d]';
const successClasses = 'flex items-center justify-center gap-2 font-semibold text-[#25d366]';
const panelClasses = 'mb-5 rounded-xl bg-[#202c33] p-3.5';
const lineClasses = 'flex justify-between py-1.5 text-sm leading-normal';

export function PayForm({
  transferId,
  destinationCountry,
  needsBankDetails,
  recipientName,
  fundingMethod,
  summary,
}: {
  transferId: string;
  destinationCountry: CountryCode;
  needsBankDetails: boolean;
  recipientName: string;
  fundingMethod: string;
  summary: PaySummary;
}) {
  // B2B ACH-pull (NON-CUSTODIAL): the payer authorizes an ACH debit of their
  // business bank — the licensed partner pulls the funds, SmartRemit never
  // captures. Collect routing / account / account type, then OTP-confirm + pay.
  if (fundingMethod === 'ach_pull') {
    return (
      <AchDebitPayForm
        transferId={transferId}
        recipientName={recipientName}
        summary={summary}
      />
    );
  }
  // Scheduled / re-opened / cron links already carry the recipient's bank
  // details — keep today's single-step, no-body POST exactly as before.
  if (!needsBankDetails) {
    return <SimplePayForm transferId={transferId} />;
  }
  // Cold-start draft: the sender enters the recipient's bank details here.
  return (
    <BankDetailsPayForm
      transferId={transferId}
      destinationCountry={destinationCountry}
      recipientName={recipientName}
      summary={summary}
    />
  );
}

// ── Phase 3 Part B: per-transaction OTP step-up (shared by both forms) ───────
// Sends a code to WhatsApp (free-form, in-session) and collects the 6 digits the
// sender enters. The parent includes `code` in its pay POST; a 403 reason:'otp'
// bounces here with an inline error.

function OtpFields({
  transferId,
  code,
  setCode,
  sent,
  setSent,
  otpError,
}: {
  transferId: string;
  code: string;
  setCode: (v: string) => void;
  sent: boolean;
  setSent: (v: boolean) => void;
  otpError?: string;
}) {
  const [requesting, setRequesting] = useState(false);

  async function requestCode() {
    setRequesting(true);
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_otp' }),
      });
      if (res.ok) setSent(true);
    } catch {
      /* leave !sent so the button stays available to retry */
    } finally {
      setRequesting(false);
    }
  }

  if (!sent) {
    return (
      <button type="button" className={secondaryBtnClasses} onClick={requestCode} disabled={requesting}>
        {requesting ? 'Sending…' : 'Send confirmation code to WhatsApp'}
      </button>
    );
  }
  return (
    <div>
      <label className={labelClasses}>
        Confirmation code
        <input
          className={otpInputClasses}
          inputMode="numeric"
          maxLength={6}
          pattern="\d{6}"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="••••••"
          autoComplete="one-time-code"
          aria-label="6-digit confirmation code"
        />
      </label>
      {otpError && <span className={fieldErrorClasses}>{otpError}</span>}
      <button type="button" className={secondaryBtnClasses} onClick={requestCode} disabled={requesting}>
        {requesting ? 'Sending…' : 'Resend code'}
      </button>
    </div>
  );
}

// ── Single-step path (scheduled / re-opened links) ──────────────────────────

function SimplePayForm({
  transferId,
}: {
  transferId: string;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [otpError, setOtpError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('paying');
    setOtpError('');
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: code }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      try {
        const data = (await res.json()) as { reason?: string };
        if (data.reason === 'otp') setOtpError('That code is incorrect or expired — resend and try again.');
      } catch {
        /* generic */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <OtpFields transferId={transferId} code={code} setCode={setCode} sent={sent} setSent={setSent} otpError={otpError} />
      <button type="submit" className={primaryBtnClasses} disabled={status === 'paying' || !sent || code.length !== 6}>
        {status === 'paying' ? 'Processing…' : 'Pay now'}
      </button>
      {status === 'error' && !otpError && (
        <p className={formErrorClasses}>Something went wrong. Please try again.</p>
      )}
    </form>
  );
}

// ── Two-step path: Step 1 collect recipient bank details, Step 2 review+pay ──

function BankDetailsPayForm({
  transferId,
  destinationCountry,
  recipientName,
  summary,
}: {
  transferId: string;
  destinationCountry: CountryCode;
  recipientName: string;
  summary: PaySummary;
}) {
  const defs: Field[] = BANK_FIELDS_BY_COUNTRY[destinationCountry] ?? [];

  const [step, setStep] = useState<Step>('details');
  const [status, setStatus] = useState<Status>('idle');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, ''])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [otpError, setOtpError] = useState('');

  function setField(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  // Step 1 → Step 2: client-side validate via the SAME validator the server
  // re-runs authoritatively (single source of truth, no drift).
  function handleContinue(e: FormEvent) {
    e.preventDefault();
    const result = validatePayoutFields(destinationCountry, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setStep('review');
  }

  // Step 2: POST { country, fields }. The route re-validates and composes the
  // canonical payoutDestination server-side (it never trusts a client-composed
  // string), so we send the raw fields, not the composed string.
  async function handlePay() {
    setStatus('paying');
    setOtpError('');
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: destinationCountry, fields: values, otp: code }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      // Surface server-side errors: a wrong/expired OTP stays on the review step;
      // a bank-field error bounces back to Step 1 so the sender can fix it.
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string>; reason?: string };
        if (data.reason === 'otp') {
          setOtpError('That code is incorrect or expired — resend and try again.');
        } else if (data.fieldErrors) {
          setErrors(data.fieldErrors);
          setStep('details');
        }
      } catch {
        /* non-JSON error body — fall through to the generic error message */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  if (step === 'review') {
    const masked = maskAccountDisplay(composePayoutDestination(destinationCountry, values));
    return (
      <div>
        <div className={stepLabelClasses}>Step 2 of 2 · Review &amp; pay</div>
        <div className={panelClasses}>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">To</span>
            <span>{recipientName}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">They receive</span>
            <span>{formatMoney(summary.destAmount, summary.destCurrency)}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Bank account</span>
            <span>{masked}</span>
          </div>
          <div className={lineClasses} style={{ fontWeight: 700 }}>
            <span className="text-[#8696a0]">Total charge</span>
            <span>{formatMoney(summary.sourceTotalCharge, summary.sourceCurrency)}</span>
          </div>
        </div>
        <OtpFields transferId={transferId} code={code} setCode={setCode} sent={sent} setSent={setSent} otpError={otpError} />
        <button type="button" className={primaryBtnClasses} onClick={handlePay} disabled={status === 'paying' || !sent || code.length !== 6}>
          {status === 'paying' ? 'Processing…' : 'Pay now'}
        </button>
        <button
          type="button"
          className={secondaryBtnClasses}
          onClick={() => {
            setStatus('idle');
            setStep('details');
          }}
          disabled={status === 'paying'}
        >
          Edit bank details
        </button>
        {status === 'error' && !otpError && (
          <p className={formErrorClasses}>Something went wrong. Please try again.</p>
        )}
      </div>
    );
  }

  // Step 1: per-country recipient bank-details form.
  return (
    <form onSubmit={handleContinue}>
      <div className={stepLabelClasses}>Step 1 of 2 · Recipient bank details</div>
      {defs.map((def) => {
        const digitOnly = typeof def.digits === 'number';
        return (
          <label key={def.key} className={labelClasses}>
            {def.label}
            <input
              className={inputClasses}
              name={def.key}
              required
              value={values[def.key] ?? ''}
              onChange={(e) => setField(def.key, e.target.value)}
              inputMode={digitOnly ? 'numeric' : 'text'}
              maxLength={digitOnly ? def.digits : undefined}
              autoComplete="off"
            />
            {errors[def.key] && <span className={fieldErrorClasses}>{errors[def.key]}</span>}
          </label>
        );
      })}
      <button type="submit" className={primaryBtnClasses}>Continue</button>
    </form>
  );
}

// ── B2B ACH-pull path (NON-CUSTODIAL) ────────────────────────────────────────
// The payer authorizes a one-time ACH debit of their BUSINESS bank. SmartRemit
// never captures the funds — the licensed partner pulls them via the signed
// settlement instruction. We collect routing / account / account type, OTP-
// confirm, then POST { ach, otp }; the route tokenizes the bank fields into an
// opaque mandate (raw digits never stored) and proceeds straight to settlement.

const selectClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';

function AchDebitPayForm({
  transferId,
  recipientName,
  summary,
}: {
  transferId: string;
  recipientName: string;
  summary: PaySummary;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState<'checking' | 'savings'>('checking');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [otpError, setOtpError] = useState('');

  // Mirror the server's checks (the route re-validates authoritatively).
  function clientErrors(): Record<string, string> {
    const e: Record<string, string> = {};
    if (routingNumber.replace(/\D/g, '').length !== 9) e.routingNumber = 'Enter the 9-digit routing number.';
    if (accountNumber.replace(/\D/g, '').length < 4) e.accountNumber = 'Enter a valid account number.';
    return e;
  }

  async function handlePay(e: FormEvent) {
    e.preventDefault();
    const e0 = clientErrors();
    if (Object.keys(e0).length > 0) {
      setErrors(e0);
      return;
    }
    setErrors({});
    setStatus('paying');
    setOtpError('');
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ach: { routingNumber, accountNumber, accountType }, otp: code }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string>; reason?: string };
        if (data.reason === 'otp') {
          setOtpError('That code is incorrect or expired — resend and try again.');
        } else if (data.fieldErrors) {
          setErrors(data.fieldErrors);
        }
      } catch {
        /* non-JSON error body — fall through to the generic error message */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment authorized! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handlePay}>
      <div className={stepLabelClasses}>Authorize ACH bank debit</div>
      <p className="mb-4 text-[13px] leading-normal text-[#8696a0]">
        We&rsquo;ll debit {formatMoney(summary.sourceTotalCharge, summary.sourceCurrency)} from your
        business account to settle with {recipientName}.
      </p>
      <label className={labelClasses}>
        Routing number
        <input
          className={inputClasses}
          name="routingNumber"
          required
          value={routingNumber}
          onChange={(e) => {
            setRoutingNumber(e.target.value.replace(/\D/g, ''));
            if (errors.routingNumber) setErrors((p) => ({ ...p, routingNumber: '' }));
          }}
          inputMode="numeric"
          maxLength={9}
          autoComplete="off"
        />
        {errors.routingNumber && <span className={fieldErrorClasses}>{errors.routingNumber}</span>}
      </label>
      <label className={labelClasses}>
        Account number
        <input
          className={inputClasses}
          name="accountNumber"
          required
          value={accountNumber}
          onChange={(e) => {
            setAccountNumber(e.target.value.replace(/\D/g, ''));
            if (errors.accountNumber) setErrors((p) => ({ ...p, accountNumber: '' }));
          }}
          inputMode="numeric"
          maxLength={17}
          autoComplete="off"
        />
        {errors.accountNumber && <span className={fieldErrorClasses}>{errors.accountNumber}</span>}
      </label>
      <label className={labelClasses}>
        Account type
        <select
          className={selectClasses}
          name="accountType"
          value={accountType}
          onChange={(e) => setAccountType(e.target.value === 'savings' ? 'savings' : 'checking')}
        >
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
        </select>
        {errors.accountType && <span className={fieldErrorClasses}>{errors.accountType}</span>}
      </label>
      <OtpFields transferId={transferId} code={code} setCode={setCode} sent={sent} setSent={setSent} otpError={otpError} />
      <button type="submit" className={primaryBtnClasses} disabled={status === 'paying' || !sent || code.length !== 6}>
        {status === 'paying' ? 'Processing…' : 'Authorize & pay'}
      </button>
      {status === 'error' && !otpError && (
        <p className={formErrorClasses}>Something went wrong. Please try again.</p>
      )}
    </form>
  );
}
