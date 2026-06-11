'use client';

import { useState, type FormEvent } from 'react';
import type { CountryCode, FundingMethod } from '@/lib/types';
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
  fundingMethod,
  destinationCountry,
  needsBankDetails,
  recipientName,
  summary,
}: {
  transferId: string;
  fundingMethod: FundingMethod;
  destinationCountry: CountryCode;
  needsBankDetails: boolean;
  recipientName: string;
  summary: PaySummary;
}) {
  // Scheduled / re-opened / cron links already carry the recipient's bank
  // details — keep today's single-step, no-body POST exactly as before.
  if (!needsBankDetails) {
    return <SimplePayForm transferId={transferId} fundingMethod={fundingMethod} />;
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
  fundingMethod,
}: {
  transferId: string;
  fundingMethod: FundingMethod;
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
      {fundingMethod === 'bank_transfer' ? <BankForm /> : <CardForm />}
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

function CardForm() {
  return (
    <>
      <label className={labelClasses}>
        Card number
        <input className={inputClasses} required placeholder="4242 4242 4242 4242" inputMode="numeric" />
      </label>
      <div className="flex gap-3">
        <label className={`${labelClasses} flex-1`}>
          Expiry
          <input className={inputClasses} required placeholder="MM/YY" />
        </label>
        <label className={`${labelClasses} flex-1`}>
          CVC
          <input className={inputClasses} required placeholder="123" inputMode="numeric" />
        </label>
      </div>
      <label className={labelClasses}>
        Name on card
        <input className={inputClasses} required placeholder="Your name" />
      </label>
    </>
  );
}

function BankForm() {
  return (
    <>
      <label className={labelClasses}>
        Account holder name
        <input className={inputClasses} required placeholder="Your full name" />
      </label>
      <label className={labelClasses}>
        Account number
        <input className={inputClasses} required placeholder="000123456789" inputMode="numeric" />
      </label>
      <label className={labelClasses}>
        Routing number
        <input className={inputClasses} required placeholder="021000021" inputMode="numeric" />
      </label>
    </>
  );
}
