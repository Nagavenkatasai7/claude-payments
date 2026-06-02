'use client';

import { useMemo, useState } from 'react';
import { calculatorMessage, waLink, WA_MESSAGES } from './wa';
import WhatsAppIcon from './WhatsAppIcon';

interface Props {
  /** Server-passed live USD→INR rate (already fallback-guarded). */
  liveRate: number;
}

const DEFAULT_AMOUNT = 1000;

function formatInr(n: number): string {
  // en-IN grouping (lakh/crore) with no decimals — recipients see whole rupees.
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function formatUsd(n: number): string {
  return '$' + n.toLocaleString('en-US');
}

/**
 * Live rate calculator. Progressive enhancement: the SSR baseline (this same
 * component) renders a real <a> with the default prefill, so it works before
 * hydration / with JS disabled. After hydration, the amount input drives both
 * the "they get" figure and the WhatsApp prefill + button label.
 */
export default function RateCalculator({ liveRate }: Props) {
  const [amount, setAmount] = useState<string>(String(DEFAULT_AMOUNT));

  const numeric = useMemo(() => {
    const n = Number.parseFloat(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amount]);

  const theyGet = numeric * liveRate;
  const hasAmount = numeric > 0;

  const message = hasAmount
    ? calculatorMessage(Math.round(numeric))
    : WA_MESSAGES.calculatorDefault;
  const href = waLink(message);

  const label = hasAmount
    ? `Send ${formatUsd(Math.round(numeric))} to India on WhatsApp`
    : 'Send money on WhatsApp';

  return (
    <div className="lp-calc lp-tier2">
      <div className="lp-calc-row">
        <label className="lp-calc-field">
          <span className="lp-calc-label">You send</span>
          <span className="lp-calc-input-wrap">
            <span className="lp-calc-prefix">$</span>
            <input
              className="lp-calc-input"
              type="number"
              inputMode="decimal"
              min={10}
              max={2999}
              step={50}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount to send in US dollars"
            />
          </span>
        </label>

        <span className="lp-calc-arrow" aria-hidden="true">
          &rarr;
        </span>

        <div className="lp-calc-field">
          <span className="lp-calc-label">They get</span>
          <span className="lp-calc-output" aria-live="polite">
            {hasAmount ? formatInr(theyGet) : '₹0'}
          </span>
        </div>
      </div>

      <p className="lp-calc-fee">Fee: $0 on your first transfer, then $1.99.</p>

      <a
        className="lp-btn-wa lp-btn-wa--block"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        <WhatsAppIcon />
        <span>{label}</span>
      </a>

      <p className="lp-calc-disclaimer">
        Live rate from our FX provider, updated hourly. Final rate is locked when
        you confirm in chat.
      </p>
    </div>
  );
}
