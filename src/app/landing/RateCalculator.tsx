'use client';

import { useMemo, useState } from 'react';
import { calculatorMessage, waLink, WA_MESSAGES } from './wa';
import { inr as formatInr } from './format';
import WhatsAppIcon from './WhatsAppIcon';
// Pure, types-only module (never fx.ts → rate.ts → log.ts in a client bundle).
import { PLATFORM_SEND_LIMITS } from '@/lib/send-limits';
// Pure and import-free (Home-Send H1): the handoff link builder + the featured-partner shape.
import { buildSendHandoffUrl, type FeaturedSendPartner } from '@/lib/send-handoff';

interface Props {
  /** Server-passed USD→INR rate; null when the FX provider refused (no figure shown). */
  rate: number | null;
  /** true only for a rate fetched live; false ⇒ an indicative cached rate. */
  live: boolean;
  /** The ECB fixing date the provider reported (YYYY-MM-DD), for the "as of" copy. */
  asOf: string | null;
  /**
   * Home-Send H1: the server-resolved featured send partner (src/lib/featured-send-partner.ts).
   * null/undefined ⇒ today's WhatsApp CTA, byte-for-byte (test-pinned).
   */
  featured?: FeaturedSendPartner | null;
}

const DEFAULT_AMOUNT = 1000;

function formatUsd(n: number): string {
  return '$' + n.toLocaleString('en-US');
}

// Tailwind recipes (light brand theme — a white card on the #f5f9ff page; the
// landing root declares the --lp-* palette these consume). The "they get"
// figure uses --lp-green-text (#047857, 5.5:1 on white): the WhatsApp green
// itself is only 1.9:1 on white, so it stays on the button (dark label, 8.4:1).
const tier2Card =
  'rounded-2xl border border-[#dbe4f0] bg-white [box-shadow:0_24px_60px_-32px_rgba(11,27,63,.35)]';
const btnWaBlock =
  'inline-flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border-0 bg-[var(--lp-wa)] px-[22px] py-[13px] min-h-12 text-base leading-normal font-bold text-[#04231A] [box-shadow:0_10px_26px_-10px_rgba(37,211,102,.6)] [transition:background_.18s_ease,transform_.18s_ease,box-shadow_.18s_ease] hover:bg-[var(--lp-wa-deep)] hover:-translate-y-px';
// Home-Send H1 secondary WhatsApp CTA (beside the partner button): same target, outline style.
const btnWaSecondary =
  'inline-flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border border-[var(--lp-wa-deep)] bg-white px-[22px] py-[11px] min-h-12 text-[15px] leading-normal font-bold text-[#04231A] [transition:background_.18s_ease] hover:bg-[#f0fdf4]';
// Home-Send H1 partner button: the landing's brand blue (#0c5bd2, white label 6.2:1).
const btnPartnerBlock =
  'inline-flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border-0 bg-[#0c5bd2] px-[22px] py-[13px] min-h-12 text-base leading-normal font-bold text-white [box-shadow:0_10px_26px_-10px_rgba(12,91,210,.6)] [transition:background_.18s_ease,transform_.18s_ease,box-shadow_.18s_ease] hover:bg-[#0a4db3] hover:-translate-y-px';

/**
 * Live rate calculator. Progressive enhancement: the SSR baseline (this same
 * component) renders a real <a> with the default prefill, so it works before
 * hydration / with JS disabled. After hydration, the amount input drives both
 * the "they get" figure and the WhatsApp prefill + button label.
 */
export default function RateCalculator({ rate, live, asOf, featured }: Props) {
  const [amount, setAmount] = useState<string>(String(DEFAULT_AMOUNT));

  const numeric = useMemo(() => {
    const n = Number.parseFloat(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amount]);

  const theyGet = rate === null ? null : numeric * rate;
  const hasAmount = numeric > 0;

  const message = hasAmount
    ? calculatorMessage(Math.round(numeric))
    : WA_MESSAGES.calculatorDefault;
  const href = waLink(message);

  const label = hasAmount
    ? `Send ${formatUsd(Math.round(numeric))} to India on WhatsApp`
    : 'Send money on WhatsApp';

  // Home-Send H1: the partner handoff button sits BESIDE the WhatsApp CTA (partner
  // primary, WhatsApp secondary) only when the server resolved a featured partner AND
  // its slug yields a link; otherwise nothing changes. The link is built here, from
  // the calculator's own state, by the pure validator in send-handoff.ts.
  const handoffHref = featured
    ? buildSendHandoffUrl({ slug: featured.slug, amount: hasAmount ? numeric : undefined, to: 'IN' })
    : null;
  const partner = featured && handoffHref ? featured : null;
  // Live copy only with a named licensed entity (the server enforces the same rule).
  const isLive = partner?.mode === 'live' && Boolean(partner.legalName);
  const confirmWhere = partner ? '' : ' in chat';

  return (
    <div className={`${tier2Card} p-[22px]`}>
      <div className="flex items-end gap-3.5">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-[12.5px] uppercase tracking-[.04em] text-[var(--lp-text-300)]">You send</span>
          <span className="flex items-center rounded-xl border border-[var(--lp-border)] bg-[var(--lp-bg-900)] px-3 focus-within:border-[#0c5bd2] focus-within:ring-2 focus-within:ring-[#0c5bd2]/25">
            <span className="text-lg leading-normal text-[var(--lp-text-300)]">$</span>
            <input
              className="min-w-0 flex-1 border-none bg-transparent py-[9px] pl-1.5 text-lg leading-normal font-bold text-[var(--lp-text-100)] focus:outline-none"
              type="number"
              inputMode="decimal"
              min={10}
              max={PLATFORM_SEND_LIMITS.maxUsd}
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
          <span className="py-[9px] text-[22px] leading-normal font-extrabold text-[var(--lp-green-text)]" aria-live="polite">
            {theyGet === null ? '—' : hasAmount ? formatInr(theyGet) : '₹0'}
          </span>
        </div>
      </div>

      <p className="mt-3.5 mb-4 text-[13.5px] leading-normal text-[var(--lp-text-300)]">
        Fee: $0 on your first transfer, then $1.99.
      </p>

      {partner && handoffHref ? (
        <>
          {!isLive ? (
            <p className="mb-2 text-center">
              <span className="inline-block rounded-full border border-[#b45309] bg-[#fffbeb] px-2.5 py-0.5 text-xs font-bold tracking-[.04em] text-[#92400e]">
                TEST — no real money
              </span>
            </p>
          ) : null}
          <a className={btnPartnerBlock} href={handoffHref}>
            <span>
              {isLive ? `Send with ${partner.displayName}` : `Try a test send with ${partner.displayName}`}
            </span>
          </a>
          <p className="mt-2.5 mb-3 text-center text-[12.5px] leading-[1.5] text-[var(--lp-text-300)]">
            {isLive
              ? `Money is handled by ${partner.legalName}, a licensed money transmitter. SmartRemit provides the technology.`
              : 'Test mode — no money moves.'}
          </p>
          <a className={btnWaSecondary} href={href} target="_blank" rel="noopener noreferrer">
            <WhatsAppIcon />
            <span>{label}</span>
          </a>
        </>
      ) : (
        <a className={btnWaBlock} href={href} target="_blank" rel="noopener noreferrer">
          <WhatsAppIcon />
          <span>{label}</span>
        </a>
      )}

      <p className="mt-3 text-xs leading-[1.5] text-[var(--lp-text-300)]">
        {rate === null
          ? `Our FX provider is temporarily unreachable, so no rate is shown. The exact rate is quoted and locked when you confirm${confirmWhere}.`
          : live
            ? `Daily reference rate from our FX provider${asOf ? ` (ECB fixing of ${asOf})` : ''}, for information. Your transfer's rate is quoted and locked when you confirm${confirmWhere}.`
            : `Indicative rate${asOf ? ` (ECB fixing of ${asOf})` : ''}: our FX provider is temporarily unreachable. The exact rate is quoted and locked when you confirm${confirmWhere}.`}
      </p>
    </div>
  );
}
