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

// Tailwind recipes (Stage 5e — values lifted verbatim from the legacy .lp
// rules; the landing root re-declares the --lp-* palette these consume).
const tier2Card =
  'rounded-[18px] border border-white/[.12] bg-white/[.06] backdrop-blur-[10px] [box-shadow:0_18px_40px_-22px_rgba(8,12,30,.7),inset_0_1px_0_rgba(255,255,255,.15)]';
const btnWaBlock =
  'inline-flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border-0 bg-[var(--lp-wa)] px-[22px] py-[13px] min-h-12 text-base leading-normal font-bold text-[#04231A] [box-shadow:0_10px_26px_-10px_rgba(37,211,102,.6)] [transition:background_.18s_ease,transform_.18s_ease,box-shadow_.18s_ease] hover:bg-[var(--lp-wa-deep)] hover:text-[#F5F8FF] hover:-translate-y-px';

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
    <div className={`${tier2Card} p-[22px]`}>
      <div className="flex items-end gap-3.5">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-[12.5px] uppercase tracking-[.04em] text-[var(--lp-text-300)]">You send</span>
          <span className="flex items-center rounded-xl border border-[var(--lp-border)] bg-[var(--lp-bg-900)] px-3">
            <span className="text-lg leading-normal text-[var(--lp-text-300)]">$</span>
            <input
              className="min-w-0 flex-1 border-none bg-transparent py-[9px] pl-1.5 text-lg leading-normal font-bold text-[var(--lp-text-100)] focus:outline-none"
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

        <span className="pb-3 text-[22px] leading-normal text-[var(--lp-text-300)]" aria-hidden="true">
          &rarr;
        </span>

        <div className="flex flex-1 flex-col gap-1.5">
          <span className="text-[12.5px] uppercase tracking-[.04em] text-[var(--lp-text-300)]">They get</span>
          <span className="py-[9px] text-[22px] leading-normal font-extrabold text-[var(--lp-wa)]" aria-live="polite">
            {hasAmount ? formatInr(theyGet) : '₹0'}
          </span>
        </div>
      </div>

      <p className="mt-3.5 mb-4 text-[13.5px] leading-normal text-[var(--lp-text-300)]">
        Fee: $0 on your first transfer, then $1.99.
      </p>

      <a className={btnWaBlock} href={href} target="_blank" rel="noopener noreferrer">
        <WhatsAppIcon />
        <span>{label}</span>
      </a>

      <p className="mt-3 text-xs leading-[1.5] text-[var(--lp-text-300)]">
        Live rate from our FX provider, updated hourly. Final rate is locked when
        you confirm in chat.
      </p>
    </div>
  );
}
