'use client';

import { useState, type FormEvent } from 'react';
import type { CountryCode, SellerPayoutMethod } from '@/lib/types';
import {
  BANK_FIELDS_BY_COUNTRY,
  validatePayoutFields,
  validateUsdcAddress,
  type Field,
} from '@/lib/payout-format';
import { requestSellerOtpAction, activateSellerAction } from './actions';
import { OTP_SEND_FAILED_MESSAGE } from '@/lib/otp-send-copy';

type Status = 'idle' | 'saving' | 'done' | 'error';

// ── Tailwind conversion of the WhatsApp-dark theme (mirrors the pay page) ─────
// 16px inputs so iOS Safari does not auto-zoom the viewport on focus.
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

function CheckMark() {
  // Inline SVG check (not the ✅ emoji) so the success state renders identically
  // across Windows / macOS / Android.
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

// The payout-method toggle: two side-by-side pills mirroring the theme's
// secondary buttons; the active pill picks up the WhatsApp green.
const methodBtnClasses =
  'flex-1 cursor-pointer rounded-xl border p-2.5 text-[13px] font-bold disabled:cursor-default';
const methodBtnActive = 'border-[#25d366] bg-[#25d366]/10 text-[#25d366]';
const methodBtnIdle = 'border-[#2a3942] bg-transparent text-[#8696a0]';

export function SellerOnboardForm({
  sellerId,
  country,
}: {
  sellerId: string;
  country: CountryCode;
}) {
  const defs: Field[] = BANK_FIELDS_BY_COUNTRY[country] ?? [];

  const [status, setStatus] = useState<Status>('idle');
  const [method, setMethod] = useState<SellerPayoutMethod>('bank');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, ''])),
  );
  const [wallet, setWallet] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [requesting, setRequesting] = useState(false);
  // Program-Fix 25 PR B: shown only when the WhatsApp send itself failed.
  const [requestError, setRequestError] = useState('');

  function setField(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  function pickMethod(next: SellerPayoutMethod) {
    setMethod(next);
    setErrors({}); // stale per-method field errors don't carry across the toggle
  }

  async function requestCode() {
    setRequesting(true);
    try {
      setRequestError('');
      const res = await requestSellerOtpAction(sellerId);
      if (res.ok) setSent(true);
      else if (res.reason === 'otp_send_failed') setRequestError(OTP_SEND_FAILED_MESSAGE);
    } catch {
      /* leave !sent so the button stays available to retry */
    } finally {
      setRequesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Client-side validate via the SAME validators the server re-runs (no drift).
    if (method === 'usdc') {
      const wr = validateUsdcAddress(wallet);
      if (!wr.ok) {
        setErrors({ walletAddress: wr.error });
        return;
      }
    } else {
      const result = validatePayoutFields(country, values);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
    }
    setErrors({});
    setStatus('saving');
    setOtpError('');
    try {
      const fields = method === 'usdc' ? { walletAddress: wallet } : values;
      const res = await activateSellerAction({ id: sellerId, method, fields, otp: code });
      if (res.ok) {
        setStatus('done');
        return;
      }
      if (res.reason === 'otp') {
        setOtpError('That code is incorrect or expired — resend and try again.');
      } else if (res.fieldErrors) {
        setErrors(res.fieldErrors);
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        <CheckMark />
        You&rsquo;re all set — your seller account is active. You can start sending bills on WhatsApp.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className={stepLabelClasses}>How you get paid</div>
      <p className="mb-4 text-[13px] leading-normal text-[#8696a0]">
        This is where you&rsquo;ll receive the money your customers pay. We encrypt and store it securely.
      </p>
      <div className="mb-4 flex gap-2" role="group" aria-label="Payout method">
        <button
          type="button"
          className={`${methodBtnClasses} ${method === 'bank' ? methodBtnActive : methodBtnIdle}`}
          aria-pressed={method === 'bank'}
          onClick={() => pickMethod('bank')}
        >
          Bank account
        </button>
        <button
          type="button"
          className={`${methodBtnClasses} ${method === 'usdc' ? methodBtnActive : methodBtnIdle}`}
          aria-pressed={method === 'usdc'}
          onClick={() => pickMethod('usdc')}
        >
          USDC wallet
        </button>
      </div>

      {method === 'bank' ? (
        defs.map((def) => {
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
        })
      ) : (
        <div>
          <label className={labelClasses}>
            USDC wallet address
            <input
              className={inputClasses}
              name="walletAddress"
              required
              value={wallet}
              onChange={(e) => {
                setWallet(e.target.value);
                if (errors.walletAddress) setErrors({});
              }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
            />
            {errors.walletAddress && <span className={fieldErrorClasses}>{errors.walletAddress}</span>}
          </label>
          <p className="mb-4 text-[13px] leading-normal text-[#8696a0]">
            Your payouts arrive as USDC (a digital dollar) sent to this wallet address by your
            payment partner — we never hold your funds. Double-check the address: crypto
            transfers can&rsquo;t be reversed.
          </p>
        </div>
      )}

      <div className="mt-5">
        {!sent ? (
          <div>
            <button type="button" className={secondaryBtnClasses} onClick={requestCode} disabled={requesting}>
              {requesting ? 'Sending…' : 'Send confirmation code to WhatsApp'}
            </button>
            {requestError && <span className={fieldErrorClasses} role="alert">{requestError}</span>}
          </div>
        ) : (
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
            {requestError && <span className={fieldErrorClasses} role="alert">{requestError}</span>}
          </div>
        )}
      </div>

      <button
        type="submit"
        className={`${primaryBtnClasses} mt-3`}
        disabled={status === 'saving' || !sent || code.length !== 6}
      >
        {status === 'saving' ? 'Activating…' : 'Finish & activate'}
      </button>
      {status === 'error' && !otpError && Object.keys(errors).length === 0 && (
        <p className={formErrorClasses}>Something went wrong. Please try again.</p>
      )}
    </form>
  );
}
