'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { payErrorMessage } from '@/lib/pay-outcome';
import { otpRequestErrorMessage } from '@/lib/otp-send-copy';
import { ACKNOWLEDGEMENT_LABEL } from '@/lib/legal/disclosure-drafts';

// Batch B2: the payment-link form. Pick how to pay (bank $1.99 / debit card
// $2.99), read the disclosure for that choice, get a WhatsApp code, pay, then
// the receipt. Every figure comes from the server render; the POST carries only
// the method, the code, the acknowledged disclosure version and the identity of
// the rate lock the figures came from (the route refuses any other lock).

export type LinkPayMethod = 'bank_transfer' | 'debit_card';

export interface LinkPayOption {
  method: LinkPayMethod;
  label: string;
  amountUsd: number;
  feeUsd: number;
  totalUsd: number;
}

interface Receipt {
  payeeName: string;
  reference: string;
  amountInr: number;
}

const INACTIVE_COPY = 'This payment link is no longer active.';
const RATE_CHANGED_COPY = 'The rate changed. Check the new amount.';

const otpInputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-center text-[22px] tracking-[0.5em] text-[#e9edef] tabular-nums';
const labelClasses = 'mb-3 block text-[13px] text-[#8696a0]';
const primaryBtnClasses =
  'w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a] disabled:cursor-default disabled:opacity-60';
const secondaryBtnClasses =
  'mt-2.5 w-full cursor-pointer rounded-3xl border border-[#2a3942] bg-transparent p-3 text-[15px] font-bold text-[#8696a0] disabled:cursor-default disabled:opacity-60';
const resendLinkClasses =
  'mt-3 block w-full cursor-pointer bg-transparent p-1 text-center text-[13px] font-semibold text-[#53bdeb] underline-offset-2 hover:underline focus-visible:underline disabled:cursor-default disabled:opacity-60';
const fieldErrorClasses = 'mt-1 block text-xs leading-normal text-[#f15c6d]';
const formErrorClasses = 'mt-2 text-[13px] text-[#f15c6d]';
const panelClasses = 'mb-5 rounded-xl bg-[#202c33] p-3.5';
const lineClasses = 'flex flex-wrap justify-between gap-x-3 py-1.5 text-sm leading-normal';

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={lineClasses} style={bold ? { fontWeight: 700 } : undefined}>
      <span className="text-[#8696a0]">{label}</span>
      <span className="min-w-0 break-words text-right">{value}</span>
    </div>
  );
}

type Status = 'idle' | 'paying' | 'done' | 'inactive' | 'error';

export function LinkPayForm({
  token,
  options,
  disclosures,
  disclosureVersion,
  quoteLockedAt,
  receipt,
}: {
  token: string;
  options: LinkPayOption[];
  disclosures: Partial<Record<LinkPayMethod, ReactNode>>;
  disclosureVersion: string | null;
  /** The rate lock these figures come from; null when a minted transfer's fixed figures are shown. */
  quoteLockedAt: string | null;
  receipt: Receipt;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<LinkPayMethod>(options[0]?.method ?? 'bank_transfer');
  const [acked, setAcked] = useState(false);
  const [sent, setSent] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [code, setCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paid, setPaid] = useState<{ transferId: string; status: string } | null>(null);

  const chosen = options.find((o) => o.method === method) ?? options[0];
  const disclosure = disclosures[method] ?? null;
  const ackMissing = disclosure !== null && disclosureVersion !== null && !acked;
  const endpoint = `/api/pay/l/${encodeURIComponent(token)}`;

  async function requestCode() {
    setRequesting(true);
    setRequestError('');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_otp' }),
      });
      if (res.ok) setSent(true);
      else if (res.status === 404) setStatus('inactive');
      else {
        const data = (await res.json().catch(() => ({}))) as { reason?: unknown };
        setRequestError(otpRequestErrorMessage(data.reason));
      }
    } catch {
      setRequestError(otpRequestErrorMessage(undefined));
    } finally {
      setRequesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (ackMissing || !chosen) return;
    setStatus('paying');
    setOtpError('');
    setErrorMessage(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: code,
          fundingMethod: chosen.method,
          ...(disclosure !== null && disclosureVersion && acked ? { disclosureVersion } : {}),
          ...(quoteLockedAt ? { quoteLockedAt } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; status?: string; transferId?: string }
        | null;
      if (res.ok && data?.ok) {
        if (data.status === 'cancelled') {
          setStatus('inactive');
          return;
        }
        setPaid({ transferId: data.transferId ?? '', status: data.status ?? 'processing' });
        setStatus('done');
        return;
      }
      if (res.status === 404) {
        setStatus('inactive');
        return;
      }
      if (data?.reason === 'quote_expired') {
        // The rate lock these figures came from lapsed or was replaced. Say so,
        // re-render the server figures (router.refresh keeps this form's state,
        // node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md:46)
        // and ask for a fresh acknowledgement of the new disclosure. The code was
        // not spent: the route refuses before checking it.
        setAcked(false);
        setErrorMessage(RATE_CHANGED_COPY);
        setStatus('error');
        router.refresh();
        return;
      }
      if (data?.reason === 'otp') setOtpError('That code is incorrect or expired. Resend and try again.');
      else setErrorMessage(payErrorMessage(data));
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'inactive') return <p className={formErrorClasses}>{INACTIVE_COPY}</p>;

  if (status === 'done' && paid && chosen) {
    return (
      <div>
        <p className="mb-4 flex items-center justify-center gap-2 font-semibold text-[#25d366]">
          <svg className="shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12.5l2.5 2.5L16 9" />
          </svg>
          {paid.status === 'in_review' ? 'Payment received. It is being checked.' : 'Payment complete'}
        </p>
        <div className={panelClasses}>
          <Line label="Paid to" value={receipt.payeeName} />
          <Line label="Reference" value={receipt.reference} />
          <Line label="They receive" value={money(receipt.amountInr, 'INR')} />
          <Line label="You paid" value={money(chosen.totalUsd, 'USD')} bold />
          <Line label="Paid with" value={chosen.label} />
          {paid.transferId && <Line label="Transfer number" value={paid.transferId} />}
        </div>
        <p className="text-[13px] leading-normal text-[#8696a0]">Keep this page or take a screenshot for your records.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {options.length > 1 && (
        <fieldset className="mb-4">
          <legend className="mb-2 text-[13px] text-[#8696a0]">How do you want to pay?</legend>
          {options.map((o) => (
            <label key={o.method} className="mb-2 flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-[#202c33] p-3 text-sm leading-normal">
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="fundingMethod"
                  value={o.method}
                  checked={method === o.method}
                  onChange={() => setMethod(o.method)}
                  disabled={status === 'paying'}
                  className="size-4 accent-[#25d366]"
                />
                {o.label}
              </span>
              <span className="text-[#8696a0]">fee {money(o.feeUsd, 'USD')}</span>
            </label>
          ))}
        </fieldset>
      )}
      {chosen && (
        <div className={panelClasses}>
          <Line label="Amount" value={money(chosen.amountUsd, 'USD')} />
          <Line label="Fee" value={money(chosen.feeUsd, 'USD')} />
          <Line label="Total charge" value={money(chosen.totalUsd, 'USD')} bold />
          <Line label="Paying with" value={chosen.label} />
        </div>
      )}
      {disclosure}
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
        </div>
      )}
      {disclosure !== null && disclosureVersion !== null && (
        <label className="mt-3 mb-3 flex items-start gap-2 text-[13px] leading-normal text-[#e9edef]">
          <input
            type="checkbox"
            name="disclosureAck"
            className="mt-0.5 size-4 shrink-0 accent-[#25d366]"
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
          />
          <span>{ACKNOWLEDGEMENT_LABEL}</span>
        </label>
      )}
      <button type="submit" className={primaryBtnClasses} disabled={status === 'paying' || !sent || code.length !== 6 || ackMissing}>
        {status === 'paying' ? 'Processing…' : chosen ? `Pay ${money(chosen.totalUsd, 'USD')}` : 'Pay now'}
      </button>
      {sent && (
        <div>
          <button type="button" className={resendLinkClasses} onClick={requestCode} disabled={requesting || status === 'paying'}>
            {requesting ? 'Sending…' : 'Resend code'}
          </button>
          {requestError && <span className={fieldErrorClasses} role="alert">{requestError}</span>}
        </div>
      )}
      {status === 'error' && !otpError && (
        <p className={formErrorClasses}>{errorMessage ?? 'Something went wrong. Please try again.'}</p>
      )}
    </form>
  );
}
