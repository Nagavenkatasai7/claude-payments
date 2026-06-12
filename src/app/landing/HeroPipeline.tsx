// The hero: a transfer flowing through the REAL SmartRemit system, n8n-style.
// Pure server-rendered JSX + CSS animation (keyframes live in tailwind.css:
// lp-node-cycle / lp-dot-cycle / lp-link-x / lp-link-y). No client JS, no
// animation libraries. The un-animated markup is fully lit — that is the
// prefers-reduced-motion fallback; motion-safe CSS dims it and replays the
// flow on a 9s loop with a staggered `--lp-delay` per stage.

import type { CSSProperties, ReactNode } from 'react';
import { inr } from './format';

interface Props {
  /** Server-passed live USD→INR rate (already fallback-guarded). */
  liveRate: number;
}

const STAGE_GAP_S = 1.05; // seconds between stage activations
const PULSE_LEAD_S = 0.35; // pulse leaves this long after its source node lights

function delayStyle(seconds: number): CSSProperties {
  return { '--lp-delay': `${seconds.toFixed(2)}s` } as CSSProperties;
}

function Node({
  index,
  step,
  label,
  children,
}: {
  index: number;
  step: string;
  label: string;
  children: ReactNode;
}) {
  const delay = delayStyle(index * STAGE_GAP_S);
  return (
    <div
      className="lp-stage relative min-w-0 rounded-2xl border border-[rgba(37,211,102,0.5)] bg-[#0b0e12] p-4 shadow-[0_0_28px_-6px_rgba(37,211,102,0.4)] lg:flex-1"
      style={delay}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className="lp-stage-dot h-2 w-2 shrink-0 rounded-full bg-[#25d366] shadow-[0_0_0_4px_rgba(37,211,102,0.18)]"
          style={delay}
        />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b94a0]">
          {step} · {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function Connector({ index }: { index: number }) {
  const delay = delayStyle(index * STAGE_GAP_S + PULSE_LEAD_S);
  return (
    <div className="flex items-center justify-center lg:w-9 lg:shrink-0 lg:self-stretch">
      {/* Vertical connector (mobile stack) */}
      <div className="relative h-9 w-[2px] overflow-hidden rounded-full bg-[linear-gradient(180deg,rgba(37,211,102,0.65),rgba(34,211,238,0.65))] lg:hidden">
        <span
          className="lp-pulse-y absolute left-1/2 h-6 w-[3px] -translate-x-1/2 rounded-full bg-[linear-gradient(180deg,transparent,#25d366,#a7f3d0)] shadow-[0_0_12px_rgba(37,211,102,0.9)]"
          style={delay}
        />
      </div>
      {/* Horizontal connector (desktop row) */}
      <div className="relative hidden h-[2px] w-full overflow-hidden rounded-full bg-[linear-gradient(90deg,rgba(37,211,102,0.65),rgba(34,211,238,0.65))] lg:block">
        <span
          className="lp-pulse-x absolute top-1/2 h-[3px] w-8 -translate-y-1/2 rounded-full bg-[linear-gradient(90deg,transparent,#25d366,#a7f3d0)] shadow-[0_0_12px_rgba(37,211,102,0.9)]"
          style={delay}
        />
      </div>
    </div>
  );
}

export default function HeroPipeline({ liveRate }: Props) {
  const payout = inr(200 * liveRate);
  const rate = '₹' + liveRate.toFixed(2);

  return (
    <div
      role="img"
      aria-label={`A live transfer flowing through SmartRemit: a WhatsApp message "Send $200 to Mom" becomes an AI quote of ${payout} at the live rate of 1 USD = ${rate}, a secure hosted pay page, a signed settlement instruction to the partner's rail, and ${payout} delivered to Mom's bank account.`}
      className="mx-auto w-full max-w-[1180px]"
    >
      <div
        aria-hidden="true"
        className="mx-auto flex w-full max-w-[440px] flex-col items-stretch lg:max-w-none lg:flex-row"
      >
        {/* 01 — the WhatsApp message */}
        <Node index={0} step="01" label="Chat">
          <div className="inline-block max-w-full rounded-xl rounded-br-[4px] bg-[#128c7e] px-3 py-2 text-[13px] leading-snug font-medium text-[#f5f7f8]">
            Send $200 to Mom
          </div>
          <p className="mt-2 text-[11.5px] text-[#8b94a0]">Customer · WhatsApp</p>
        </Node>
        <Connector index={0} />

        {/* 02 — the AI quote */}
        <Node index={1} step="02" label="AI quote">
          <p className="text-[16px] font-bold tracking-[-0.01em] text-[#25d366]">
            $200 → {payout}
          </p>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#8b94a0]">
            1 USD = {rate} · live mid-market
            <br />
            fee $0 on your first transfer
          </p>
        </Node>
        <Connector index={1} />

        {/* 03 — the secure pay page */}
        <Node index={2} step="03" label="Pay">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#f5f7f8]">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#22d3ee"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Secure pay page
          </p>
          <p className="mt-1.5 truncate font-mono text-[11px] text-[#8b94a0]">
            smartremit.ai/pay/tr_8f3k
          </p>
        </Node>
        <Connector index={2} />

        {/* 04 — the signed settlement instruction */}
        <Node index={3} step="04" label="Settle">
          <p className="font-mono text-[11px] leading-relaxed text-[#8b94a0]">
            <span className="font-semibold text-[#22d3ee]">POST</span> partner-rail/instruct
            <br />
            <span className="text-[#25d366]">✓</span> sig v1=9f2c41…
          </p>
          <p className="mt-1.5 text-[11.5px] text-[#8b94a0]">Signed → partner&rsquo;s rail</p>
        </Node>
        <Connector index={3} />

        {/* 05 — delivered */}
        <Node index={4} step="05" label="Delivered">
          <p className="text-[16px] font-bold tracking-[-0.01em] text-[#25d366]">
            ✓ {payout} delivered
          </p>
          <p className="mt-1.5 text-[11.5px] text-[#8b94a0]">Mom · HDFC ••6210 · in minutes</p>
        </Node>
      </div>

      <p className="mt-5 text-center text-[12.5px] text-[#8b94a0]">
        A real transfer moving through SmartRemit — conversation, quote, pay, settle, delivered.
        Funds never touch us.
      </p>
    </div>
  );
}
