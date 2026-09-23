'use client';

import { useState, type FormEvent } from 'react';
import type { CountryCode } from '@/lib/types';
import { BANK_FIELDS_BY_COUNTRY, validatePayoutFields, type Field } from '@/lib/payout-format';

// Cross-border B2B buyer pay form (Plan 4). The buyer authorizes a debit of THEIR
// LOCAL bank (their country's per-country field schema), then OTP-confirms + pays.
// NON-CUSTODIAL: the licensed partner debits the buyer AND pays the seller via the
// signed instruction — SmartRemit never captures. Self-contained WhatsApp-dark
// theme so /pay/[transferId] stays byte-unchanged.

type Status = 'idle' | 'paying' | 'done' | 'error';
type Step = 'details' | 'review';

const inputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';
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

function SuccessCheck() {
  return (
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
  );
}

function OtpFields({
  invoiceId,
  code,
  setCode,
  sent,
  setSent,
  otpError,
}: {
  invoiceId: string;
  code: string;
  setCode: (v: string) => void;
  sent: boolean;
  setSent: (v: boolean) => void;
  otpError?: string;
}) {
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');

  async function requestCode() {
    setRequesting(true);
    setRequestError('');
    try {
      const res = await fetch(`/api/pay/b2b/${invoiceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_otp' }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && data.ok) {
        setSent(true);
      } else {
        // Honest non-delivery: do NOT advance to the code input pretending a code is
        // on the way. Tell the buyer + point them back to the sender.
        setRequestError(
          "We couldn't send a code to this WhatsApp number. Make sure it's on WhatsApp, or ask whoever sent the bill to resend it.",
        );
      }
    } catch {
      setRequestError("We couldn't send the code right now — please try again.");
    } finally {
      setRequesting(false);
    }
  }

  if (!sent) {
    return (
      <div>
        <button type="button" className={secondaryBtnClasses} onClick={requestCode} disabled={requesting}>
          {requesting ? 'Sending…' : 'Send confirmation code to WhatsApp'}
        </button>
        {requestError && <span className={fieldErrorClasses}>{requestError}</span>}
      </div>
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
      {requestError && <span className={fieldErrorClasses}>{requestError}</span>}
    </div>
  );
}

export function BillPayForm({
  invoiceId,
  buyerCountry,
  sellerBusinessName,
  buyerTotal,
  buyerCurrency,
}: {
  invoiceId: string;
  buyerCountry: CountryCode;
  sellerBusinessName: string;
  buyerTotal: number;
  buyerCurrency: string;
}) {
  const defs: Field[] = BANK_FIELDS_BY_COUNTRY[buyerCountry] ?? [];

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

  function handleContinue(e: FormEvent) {
    e.preventDefault();
    const result = validatePayoutFields(buyerCountry, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setStep('review');
  }

  async function handlePay() {
    setStatus('paying');
    setOtpError('');
    try {
      const res = await fetch(`/api/pay/b2b/${invoiceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: buyerCountry, fields: values, otp: code }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string>; reason?: string };
        if (data.reason === 'quote_expired') {
          // The rate moved past the lock — reload so the buyer reviews + authorizes
          // the FRESH total (never charge a figure they didn't see).
          window.location.reload();
          return;
        }
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
        <SuccessCheck />
        Payment authorized! Check WhatsApp for your receipt.
      </p>
    );
  }

  if (step === 'review') {
    return (
      <div>
        <div className={stepLabelClasses}>Step 2 of 2 · Confirm &amp; pay</div>
        <p className="mb-4 text-[13px] leading-normal text-[#8696a0]">
          We&rsquo;ll debit {formatMoney(buyerTotal, buyerCurrency)} from your bank to settle your bill with{' '}
          {sellerBusinessName}.
        </p>
        <OtpFields
          invoiceId={invoiceId}
          code={code}
          setCode={setCode}
          sent={sent}
          setSent={setSent}
          otpError={otpError}
        />
        <button
          type="button"
          className={primaryBtnClasses}
          onClick={handlePay}
          disabled={status === 'paying' || !sent || code.length !== 6}
        >
          {status === 'paying' ? 'Processing…' : 'Authorize & pay'}
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

  return (
    <form onSubmit={handleContinue}>
      <div className={stepLabelClasses}>Step 1 of 2 · Your bank details</div>
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
      <button type="submit" className={primaryBtnClasses}>
        Continue
      </button>
    </form>
  );
}
