// "What's inside" product mockups — stylized JSX recreations of the REAL
// product surfaces (no screenshots, no images, no client JS). Every number
// and label reflects an actual product truth: non-custodial settlement,
// sanctions screening that never turns off, 8 corridors, live mid-market FX.

import { inr } from './format';

const shell =
  'rounded-2xl border border-white/10 bg-white/[0.04] shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]';

const windowDots = (
  <span className="flex gap-1.5" aria-hidden="true">
    <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
    <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
    <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
  </span>
);

/** (a) The WhatsApp conversation — quote → pay link → delivered. */
export function ChatMock({ liveRate }: { liveRate: number }) {
  return (
    <div
      className={`${shell} mx-auto w-full max-w-[400px] overflow-hidden`}
      role="img"
      aria-label="The SmartRemit WhatsApp conversation: a customer asks to send $500 to India, the assistant quotes the live rate, locks it behind a secure pay link, and confirms delivery."
    >
      <div className="flex items-center gap-2.5 border-b border-white/10 bg-[rgba(18,140,126,0.28)] px-4 py-3">
        <span
          className="grid h-8 w-8 place-items-center rounded-full bg-[#25d366] text-[14px] text-[#04231a]"
          aria-hidden="true"
        >
          ◈
        </span>
        <span className="text-[14px] font-bold text-[#f5f7f8]">SmartRemit</span>
        <span className="ml-auto text-[11.5px] text-[#25d366]">online</span>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2.5 px-4 py-4">
        <div className="max-w-[85%] self-end rounded-[14px] rounded-br-[4px] bg-[#128c7e] px-3 py-2 text-[13.5px] leading-snug text-[#f5f7f8]">
          Send $500 to my brother in India
        </div>
        <div className="max-w-[88%] self-start rounded-[14px] rounded-bl-[4px] border border-[rgba(37,211,102,0.35)] bg-[#0b0e12] px-3 py-2.5 text-[13.5px] leading-snug text-[#f5f7f8]">
          <span className="text-[15px] font-bold text-[#25d366]">$500 → {inr(500 * liveRate)}</span>
          <br />
          <span className="text-[#8b94a0]">
            1 USD = ₹{liveRate.toFixed(2)} · fee $0 first transfer
          </span>
        </div>
        <div className="max-w-[88%] self-start rounded-[14px] rounded-bl-[4px] bg-[#13181f] px-3 py-2.5 text-[13.5px] leading-snug text-[#f5f7f8]">
          Rate locked. Pay securely here:
          <br />
          <span className="font-mono text-[12px] text-[#22d3ee]">smartremit.ai/pay/tr_8f3k</span>
        </div>
        <div className="max-w-[88%] self-start rounded-[14px] rounded-bl-[4px] bg-[#13181f] px-3 py-2.5 text-[13.5px] font-semibold leading-snug text-[#25d366]">
          Delivered ✓ — {inr(500 * liveRate)} to Arjun
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
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        {windowDots}
        <span className="font-mono text-[11.5px] text-[#8b94a0]">admin-dashboard / ops</span>
      </div>
      <div aria-hidden="true" className="p-4">
        <div className="grid grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-white/10 bg-[#0b0e12] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#8b94a0]">In flight</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#f5f7f8]">24</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#0b0e12] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#8b94a0]">In review</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#f0b454]">3</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#0b0e12] p-3">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-[#8b94a0]">Delivered</p>
            <p className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-[#25d366]">181</p>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {[
            { id: 'tr_8f3k', route: '$200 → ₹16,9xx', tag: 'Delivered', cls: 'text-[#25d366] border-[rgba(37,211,102,0.35)] bg-[rgba(37,211,102,0.08)]' },
            { id: 'tr_2c9a', route: '$1,250 → ₹105,8xx', tag: 'Review', cls: 'text-[#f0b454] border-[rgba(240,180,84,0.35)] bg-[rgba(240,180,84,0.08)]' },
            { id: 'tr_9d1m', route: '$80 → AED 29x', tag: 'Paid', cls: 'text-[#22d3ee] border-[rgba(34,211,238,0.35)] bg-[rgba(34,211,238,0.08)]' },
          ].map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-[#0b0e12] px-3 py-2"
            >
              <span className="font-mono text-[11.5px] text-[#8b94a0]">{r.id}</span>
              <span className="truncate text-[12px] text-[#f5f7f8]">{r.route}</span>
              <span
                className={`ml-auto rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${r.cls}`}
              >
                {r.tag}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] text-[#8b94a0]">
          PII encrypted at rest — every staff reveal is audited.
        </p>
      </div>
    </div>
  );
}

/** (c) The partner rail — the signed instruction → callback loop. */
export function RailMock() {
  return (
    <div
      className={`${shell} mx-auto w-full max-w-[520px] overflow-hidden`}
      role="img"
      aria-label="A signed settlement instruction: SmartRemit posts a signed payload to the partner's rail and the rail answers with a signed status callback."
    >
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        {windowDots}
        <span className="font-mono text-[11.5px] text-[#8b94a0]">settlement instruction</span>
      </div>
      <pre
        aria-hidden="true"
        className="overflow-x-auto p-4 font-mono text-[11.5px] leading-[1.8] text-[#aeb6c0] sm:text-[12.5px]"
      >
        <code>
          <span className="font-semibold text-[#22d3ee]">POST</span> https://rail.acme-remit.example/instruct{'\n'}
          <span className="text-[#8b94a0]">X-SmartRemit-Signature:</span> t=1765991820,v1=9f2c41ab…{'\n'}
          {'{'} <span className="text-[#25d366]">&quot;transfer&quot;</span>: &quot;tr_8f3k&quot;, <span className="text-[#25d366]">&quot;payout&quot;</span>: {'{'} &quot;INR&quot;: &quot;16950.00&quot;, &quot;account&quot;: &quot;••6210&quot; {'}'} {'}'}{'\n'}
          <span className="text-[#25d366]">← 200</span> {'{'} &quot;status&quot;: &quot;accepted&quot; {'}'}  <span className="text-[#5b6470]">{'// signed callback follows'}</span>
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
      <div aria-hidden="true" className="bg-[#0b0e12] p-4">
        <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#8b94a0]">
          Customer agent
        </p>
        <div className="flex flex-col gap-2">
          <div className="max-w-[92%] self-end rounded-[12px] rounded-br-[4px] bg-[#128c7e] px-3 py-2 text-[12.5px] leading-snug text-[#f5f7f8]">
            Did Mom get the money?
          </div>
          <div className="max-w-[92%] self-start rounded-[12px] rounded-bl-[4px] bg-[#13181f] px-3 py-2 text-[12.5px] leading-snug text-[#f5f7f8]">
            Yes — delivered at 2:14 PM ✓<br />
            <span className="font-mono text-[11px] text-[#22d3ee]">smartremit.ai/account</span>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="border-t border-white/10 bg-[#0b0e12] p-4 sm:border-t-0 sm:border-l">
        <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#8b94a0]">
          On every transfer
        </p>
        <ul className="flex flex-col gap-2 text-[12.5px] text-[#f5f7f8]">
          <li className="flex items-baseline gap-2">
            <span className="text-[#25d366]">✓</span> Sanctions screening — always on
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#25d366]">✓</span> Velocity limits per customer
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#25d366]">✓</span> Tiered KYC — partner-delegable
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-[#25d366]">✓</span> Full audit trail, end to end
          </li>
        </ul>
      </div>
    </div>
  );
}
