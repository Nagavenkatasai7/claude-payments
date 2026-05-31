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

// ── Existing single-step path (unchanged behaviour: bodyless POST) ──────────

function SimplePayForm({
  transferId,
  fundingMethod,
}: {
  transferId: string;
  fundingMethod: FundingMethod;
}) {
  const [status, setStatus] = useState<Status>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('paying');
    try {
      const res = await fetch(`/api/pay/${transferId}`, { method: 'POST' });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className="done">
        &#x2705; Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {fundingMethod === 'bank_transfer' ? <BankForm /> : <CardForm />}
      <button type="submit" disabled={status === 'paying'}>
        {status === 'paying' ? 'Processing…' : 'Pay now'}
      </button>
      {status === 'error' && (
        <p className="err">Something went wrong. Please try again.</p>
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
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: destinationCountry, fields: values }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      // Surface server-side field errors (e.g. a digit rule the client missed),
      // bounce back to Step 1 so the sender can fix them.
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string> };
        if (data.fieldErrors) {
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
      <p className="done">
        &#x2705; Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  if (step === 'review') {
    const masked = maskAccountDisplay(composePayoutDestination(destinationCountry, values));
    return (
      <div className="pay-step">
        <div className="pay-step-label">Step 2 of 2 · Review &amp; pay</div>
        <div className="summary">
          <div className="row">
            <span>To</span>
            <span>{recipientName}</span>
          </div>
          <div className="row">
            <span>They receive</span>
            <span>{formatMoney(summary.destAmount, summary.destCurrency)}</span>
          </div>
          <div className="row">
            <span>Bank account</span>
            <span>{masked}</span>
          </div>
          <div className="row" style={{ fontWeight: 700 }}>
            <span>Total charge</span>
            <span>{formatMoney(summary.sourceTotalCharge, summary.sourceCurrency)}</span>
          </div>
        </div>
        <button type="button" onClick={handlePay} disabled={status === 'paying'}>
          {status === 'paying' ? 'Processing…' : 'Pay now'}
        </button>
        <button
          type="button"
          className="pay-secondary"
          onClick={() => {
            setStatus('idle');
            setStep('details');
          }}
          disabled={status === 'paying'}
        >
          Edit bank details
        </button>
        {status === 'error' && (
          <p className="err">Something went wrong. Please try again.</p>
        )}
      </div>
    );
  }

  // Step 1: per-country recipient bank-details form.
  return (
    <form onSubmit={handleContinue} className="pay-step">
      <div className="pay-step-label">Step 1 of 2 · Recipient bank details</div>
      {defs.map((def) => {
        const digitOnly = typeof def.digits === 'number';
        return (
          <label key={def.key}>
            {def.label}
            <input
              name={def.key}
              required
              value={values[def.key] ?? ''}
              onChange={(e) => setField(def.key, e.target.value)}
              inputMode={digitOnly ? 'numeric' : 'text'}
              maxLength={digitOnly ? def.digits : undefined}
              autoComplete="off"
            />
            {errors[def.key] && <span className="field-err">{errors[def.key]}</span>}
          </label>
        );
      })}
      <button type="submit">Continue</button>
    </form>
  );
}

function CardForm() {
  return (
    <>
      <label>
        Card number
        <input required placeholder="4242 4242 4242 4242" inputMode="numeric" />
      </label>
      <div className="pair">
        <label>
          Expiry
          <input required placeholder="MM/YY" />
        </label>
        <label>
          CVC
          <input required placeholder="123" inputMode="numeric" />
        </label>
      </div>
      <label>
        Name on card
        <input required placeholder="Your name" />
      </label>
    </>
  );
}

function BankForm() {
  return (
    <>
      <label>
        Account holder name
        <input required placeholder="Your full name" />
      </label>
      <label>
        Account number
        <input required placeholder="000123456789" inputMode="numeric" />
      </label>
      <label>
        Routing number
        <input required placeholder="021000021" inputMode="numeric" />
      </label>
    </>
  );
}
