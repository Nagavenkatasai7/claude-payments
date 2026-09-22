// "What's inside" product mockups — stylized JSX recreations of the REAL
// product surfaces (no screenshots, no client JS). Every number and label
// reflects an actual product truth: non-custodial settlement, sanctions
// screening that never turns off, 8 corridors, live mid-market FX.
//
// Light brand theme: white surfaces on the #f5f9ff page, navy (#0b1b3f) text,
// slate (#475569 / #52607a) secondary. Brand green is too light for text on
// white (#34d399 = 1.9:1), so figures use #047857 (5.5:1 on white).

import Image from 'next/image';
import { inr } from './format';

const shell =
  'rounded-2xl border border-[#dbe4f0] bg-white shadow-[0_24px_60px_-32px_rgba(11,27,63,0.35)]';

const windowDots = (
  <span className="flex gap-1.5" aria-hidden="true">
    <span className="h-2.5 w-2.5 rounded-full bg-[#dbe4f0]" />
    <span className="h-2.5 w-2.5 rounded-full bg-[#dbe4f0]" />
    <span className="h-2.5 w-2.5 rounded-full bg-[#dbe4f0]" />
  </span>
);

/** (a) The WhatsApp conversation — quote → pay link → delivered, inside a
 *  phone frame (the hero visual). Light WhatsApp chrome: #efeae2 wallpaper,
 *  #d9fdd3 outgoing bubbles, white incoming; navy text on both (15:1+). */
export function ChatMock({ rate }: { rate: number }) {
  const bubbleIn =
    'relative max-w-[86%] self-start rounded-[14px] rounded-tl-[4px] bg-white px-3 pt-2 pb-4 text-[13.5px] leading-snug text-[#0b1b3f] shadow-[0_1px_1px_rgba(11,27,63,0.08)]';
  const stamp = 'absolute right-2.5 bottom-1 text-[10px] text-[#52607a]';
  return (
    <div
      className="relative mx-auto w-full max-w-[340px]"
      role="img"
      aria-label="The SmartRemit WhatsApp conversation: a customer asks to send $500 to India, the assistant quotes the live rate, locks it behind a secure pay link, and confirms delivery."
    >
      <div
        aria-hidden="true"
        className="rounded-[50px] bg-[#0b1b3f] p-[10px] shadow-[0_30px_60px_-28px_rgba(11,27,63,0.5)]"
      >
        <div className="relative overflow-hidden rounded-[40px] bg-[#efeae2]">
          {/* Status bar + dynamic island */}
          <div className="relative flex h-11 items-center justify-between bg-white px-7 text-[12.5px] font-semibold text-[#0b1b3f]">
            <span>9:41</span>
            <span className="absolute top-2.5 left-1/2 h-[24px] w-[92px] -translate-x-1/2 rounded-full bg-[#0b1b3f]" />
            <span className="flex items-center gap-1">
              <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor">
                <rect x="0" y="7" width="3" height="4" rx="1" />
                <rect x="4.3" y="5" width="3" height="6" rx="1" />
                <rect x="8.6" y="2.5" width="3" height="8.5" rx="1" />
                <rect x="12.9" y="0" width="3" height="11" rx="1" />
              </svg>
              <span className="ml-1 inline-block h-[11px] w-[22px] rounded-[3px] border border-[#0b1b3f]/60 p-[1.5px]">
                <span className="block h-full w-[75%] rounded-[1.5px] bg-[#0b1b3f]" />
              </span>
            </span>
          </div>

          {/* Chat header */}
          <div className="flex items-center gap-3 border-b border-[#e6edf6] bg-white px-4 pt-1 pb-3">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="#0c5bd2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2L2 8l6 6" />
            </svg>
            <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-[#dbe4f0]">
              <Image src="/brand/smartremit-mark.png" alt="" width={28} height={28} />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[14.5px] font-bold text-[#0b1b3f]">SmartRemit</span>
              <span className="text-[11.5px] font-medium text-[#047857]">online</span>
            </span>
          </div>

          {/* Messages */}
          <div className="flex flex-col gap-2.5 px-3.5 pt-4 pb-5">
            <span className="self-center rounded-md bg-white/80 px-2.5 py-0.5 text-[10.5px] font-medium text-[#475569]">
              Today
            </span>
            <div className="relative max-w-[82%] self-end rounded-[14px] rounded-tr-[4px] bg-[#d9fdd3] px-3 pt-2 pb-4 text-[13.5px] leading-snug text-[#0b1b3f] shadow-[0_1px_1px_rgba(11,27,63,0.08)]">
              Send $500 to my brother in India
              <span className={stamp}>
                10:24 <span className="text-[#0c5bd2]">✓✓</span>
              </span>
            </div>
            <div className={bubbleIn}>
              <span className="text-[15.5px] font-bold text-[#047857]">$500 → {inr(500 * rate)}</span>
              <br />
              <span className="text-[#52607a]">
                1 USD = ₹{rate.toFixed(2)} · fee $0 first transfer
              </span>
              <span className={stamp}>10:24</span>
            </div>
            <div className={bubbleIn}>
              Rate locked. Pay securely here:
              <br />
              <span className="font-mono text-[12px] text-[#0c5bd2]">smartremit.ai/pay/tr_8f3k</span>
              <span className={stamp}>10:25</span>
            </div>
            <div className={`${bubbleIn} font-semibold text-[#047857]`}>
              Delivered ✓ — {inr(500 * rate)} to Arjun
              <span className={`${stamp} font-normal`}>10:31</span>
            </div>
          </div>

          {/* Composer */}
          <div className="flex items-center gap-2 px-3 pb-5">
            <span className="flex h-10 flex-1 items-center rounded-full bg-white px-4 text-[13px] text-[#667085] shadow-[0_1px_1px_rgba(11,27,63,0.08)]">
              Type a message
            </span>
            <span className="grid h-10 w-10 place-items-center rounded-full bg-[#25d366] text-[#04231a]">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
              </svg>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** (b) The admin ops dashboard — live transfers, compliance queue, FX. */
export function OpsMock() {
  return (
    <div
      className={`${shell} mx-auto w-full max-w-[460px] overflow-hidden`}
      role="img"
      aria-label="The SmartRemit operations dashboard: live transfer counts, a compliance review queue, and per-transfer rows with delivery status."
    >
      <div className="flex items-center gap-3 border-b border-[#dbe4f0] px-4 py-3">
        {windowDots}
        <span className="font-mono text-[11.5px] text-[#52607a]">admin-dashboard / ops</span>
      </div>
      <div aria-hidden="true" className="p-4">
        <div className="grid grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-[#dbe4f0] bg-[#f5f9ff] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#52607a]">In flight</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#0b1b3f]">24</p>
          </div>
          <div className="rounded-xl border border-[#dbe4f0] bg-[#f5f9ff] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#52607a]">In review</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#b45309]">3</p>
          </div>
          <div className="rounded-xl border border-[#dbe4f0] bg-[#f5f9ff] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#52607a]">Delivered</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#047857]">181</p>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {[
            { id: 'tr_8f3k', route: '$200 → ₹16,9xx', tag: 'Delivered', cls: 'text-[#047857] border-[#a7e3c6] bg-[#e7f7ef]' },
            { id: 'tr_2c9a', route: '$1,250 → ₹105,8xx', tag: 'Review', cls: 'text-[#b45309] border-[#f5d49c] bg-[#fff4e5]' },
            { id: 'tr_9d1m', route: '$80 → AED 29x', tag: 'Paid', cls: 'text-[#0c5bd2] border-[#bcd3f5] bg-[#eaf2ff]' },
          ].map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2.5 rounded-lg border border-[#e6edf6] bg-white px-3 py-2"
            >
              <span className="font-mono text-[11.5px] text-[#52607a]">{r.id}</span>
              <span className="truncate text-[12px] text-[#0b1b3f]">{r.route}</span>
              <span
                className={`ml-auto rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${r.cls}`}
              >
                {r.tag}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] text-[#52607a]">
          PII encrypted at rest — every staff reveal is audited.
        </p>
      </div>
    </div>
  );
}

/** (c) The partner rail — the signed instruction → callback loop. A navy code
 *  panel (the one dark surface on the page), so the sky/green syntax colours
 *  keep their contrast (#48b3f5 7.3:1, #6bebae 11.4:1 on #0b1b3f). */
export function RailMock() {
  return (
    <div
      className="mx-auto w-full max-w-[520px] overflow-hidden rounded-2xl border border-[#0b1b3f] bg-[#0b1b3f] shadow-[0_24px_60px_-30px_rgba(11,27,63,0.55)]"
      role="img"
      aria-label="A signed settlement instruction: SmartRemit posts a signed payload to the partner's rail and the rail answers with a signed status callback."
    >
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
        </span>
        <span className="font-mono text-[11.5px] text-[#94a3b8]">settlement instruction</span>
      </div>
      <pre
        aria-hidden="true"
        className="overflow-x-auto p-4 font-mono text-[11.5px] leading-[1.8] text-[#cbd5e1] sm:text-[12.5px]"
      >
        <code>
          <span className="font-semibold text-[#48b3f5]">POST</span> https://rail.acme-remit.example/instruct{'\n'}
          <span className="text-[#94a3b8]">X-SmartRemit-Signature:</span> t=1765991820,v1=9f2c41ab…{'\n'}
          {'{'} <span className="text-[#6bebae]">&quot;transfer&quot;</span>: &quot;tr_8f3k&quot;, <span className="text-[#6bebae]">&quot;payout&quot;</span>: {'{'} &quot;INR&quot;: &quot;16950.00&quot;, &quot;account&quot;: &quot;••6210&quot; {'}'} {'}'}{'\n'}
          <span className="text-[#6bebae]">← 200</span> {'{'} &quot;status&quot;: &quot;accepted&quot; {'}'}  <span className="text-[#94a3b8]">{'// signed callback follows'}</span>
        </code>
      </pre>
    </div>
  );
}

/** (d) The AI layer — customer agent + always-on screening. */
export function AiMock() {
  return (
    <div
      className={`${shell} mx-auto grid w-full max-w-[520px] overflow-hidden sm:grid-cols-2`}
      role="img"
      aria-label="SmartRemit's AI layer: a customer-facing agent that answers in plain language, beside the compliance checks that run on every transfer — sanctions screening always on."
    >
      <div aria-hidden="true" className="bg-[#efeae2] p-4">
        <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#475569]">
          Customer agent
        </p>
        <div className="flex flex-col gap-2">
          <div className="max-w-[92%] self-end rounded-[12px] rounded-br-[4px] bg-[#d9fdd3] px-3 py-2 text-[12.5px] leading-snug text-[#0b1b3f]">
            Did Mom get the money?
          </div>
          <div className="max-w-[92%] self-start rounded-[12px] rounded-bl-[4px] bg-white px-3 py-2 text-[12.5px] leading-snug text-[#0b1b3f]">
            Yes — delivered at 2:14 PM ✓<br />
            <span className="font-mono text-[11px] text-[#0c5bd2]">smartremit.ai/account</span>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="border-t border-[#dbe4f0] bg-white p-4 sm:border-t-0 sm:border-l">
        <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#52607a]">
          On every transfer
        </p>
        <ul className="flex flex-col gap-2 text-[12.5px] text-[#0b1b3f]">
          <li className="flex items-baseline gap-2">
            <span className="text-[#047857]">✓</span> Sanctions screening — always on
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#047857]">✓</span> Velocity limits per customer
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#047857]">✓</span> Tiered KYC — partner-delegable
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#047857]">✓</span> Full audit trail, end to end
          </li>
        </ul>
      </div>
    </div>
  );
}
