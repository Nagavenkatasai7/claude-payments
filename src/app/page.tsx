import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { getFxRate, FALLBACK_FX_RATE } from '@/lib/rate';
import { waLink, WA_MESSAGES, corridorMessage } from './landing/wa';
import WhatsAppIcon from './landing/WhatsAppIcon';
import { BankIcon, BadgeIcon, ShieldIcon, AuditIcon } from './landing/TrustIcons';
import RateCalculator from './landing/RateCalculator';
import HeroPipeline from './landing/HeroPipeline';
import { ChatMock, OpsMock, RailMock, AiMock } from './landing/showcase';

// Self-hosted Inter, scoped to the landing tree only (applied on the landing
// root div), so it never touches the sh-* dashboard or .payapp themes.
const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'SmartRemit — Send money by chatting. Watch it arrive.',
  description:
    'An AI agent quotes the live mid-market rate in WhatsApp, a hosted page takes payment, and licensed partners settle. Non-custodial, sanctions-screened, 8 corridors — any direction.',
  openGraph: {
    title: 'SmartRemit — Send money by chatting. Watch it arrive.',
    description:
      'An AI agent quotes live mid-market FX in WhatsApp; licensed partners settle. Non-custodial remittance infrastructure across 8 corridors.',
    type: 'website',
  },
};

// Rate refreshes hourly; getFxRate() already caches for 1h, so the page stays
// fast and mostly static.
export const revalidate = 3600;

// `code` = ISO-3166 alpha-2, used to pick a self-hosted flag SVG from /public/flags.
const COUNTRIES = [
  { name: 'United States', short: 'US', code: 'us' },
  { name: 'Canada', short: 'Canada', code: 'ca' },
  { name: 'United Kingdom', short: 'UK', code: 'gb' },
  { name: 'UAE', short: 'UAE', code: 'ae' },
  { name: 'Singapore', short: 'Singapore', code: 'sg' },
  { name: 'Australia', short: 'Australia', code: 'au' },
  { name: 'New Zealand', short: 'New Zealand', code: 'nz' },
  { name: 'India', short: 'India', code: 'in' },
];

// Scroll-reveal recipe (existing lp-rise keyframe; progressive — only engages
// where animation-timeline is supported, and only under motion-safe).
const RISE =
  'motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]';

// Button recipes.
const BTN_WA =
  'inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-full bg-[#25d366] px-7 text-[16px] font-bold text-[#04231a] shadow-[0_10px_30px_-10px_rgba(37,211,102,0.65)] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]';
const BTN_GHOST =
  'inline-flex min-h-[52px] items-center justify-center gap-2 rounded-full border border-white/15 px-7 text-[16px] font-semibold text-[#f5f7f8] transition-[border-color,background-color] duration-150 hover:border-white/40 hover:bg-white/[0.04]';

// Repeated type recipes (showcase rows + footer columns).
const EYEBROW = 'mb-3 text-[13px] font-semibold uppercase tracking-[0.16em]';
const SHOWCASE_H3 = 'text-[clamp(24px,3.2vw,38px)] font-semibold leading-[1.12] tracking-[-0.02em]';
const SHOWCASE_COPY = 'mt-4 max-w-[46ch] text-[16px] leading-relaxed text-[#8b94a0]';
const FOOT_HEAD = 'mb-4 block text-[12px] font-bold uppercase tracking-[0.1em] text-[#8b94a0]';
const FOOT_LIST = 'flex flex-col gap-2.5 text-[14px] text-[#aeb6c0]';

function fmtRate(rate: number): string {
  return '₹' + rate.toFixed(2);
}

function LoginMenu() {
  const item =
    'flex flex-col gap-0.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.06]';
  return (
    <div className="group relative max-[760px]:hidden">
      <a
        className="inline-flex min-h-11 items-center gap-1.5 text-[14px] text-[#8b94a0] transition-colors hover:text-[#f5f7f8]"
        href="/account/login"
        aria-haspopup="true"
      >
        Log in
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 3.5l3 3 3-3" />
        </svg>
      </a>
      {/* CSS-only hover/focus menu — every destination is a real link. */}
      <div className="invisible absolute right-0 top-full z-50 pt-2 opacity-0 transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        <div className="w-64 rounded-2xl border border-white/10 bg-[#0b0e12] p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]">
          <a className={item} href="/account/login">
            <span className="text-[14px] font-semibold text-[#f5f7f8]">Customers</span>
            <span className="text-[12px] text-[#8b94a0]">Track transfers &amp; receipts</span>
          </a>
          <a className={item} href="/login">
            <span className="text-[14px] font-semibold text-[#f5f7f8]">Employee portal</span>
            <span className="text-[12px] text-[#8b94a0]">Staff &amp; partner dashboards</span>
          </a>
          <a className={item} href="/docs">
            <span className="text-[14px] font-semibold text-[#f5f7f8]">Partners</span>
            <span className="text-[12px] text-[#8b94a0]">Integration docs &amp; API</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export default async function LandingPage() {
  // getFxRate() never throws (internal try/catch → fallback), but wrap
  // defensively so the page can never error if FX is down.
  let liveRate = FALLBACK_FX_RATE;
  try {
    const r = await getFxRate();
    if (Number.isFinite(r) && r > 0) liveRate = r;
  } catch {
    liveRate = FALLBACK_FX_RATE;
  }

  const genericHref = waLink(WA_MESSAGES.generic);

  return (
    // The [--lp-*] custom properties feed RateCalculator's legacy var hooks.
    <div
      className={`${inter.className} min-h-svh overflow-x-hidden bg-[#050607] leading-[1.6] text-[#f5f7f8] antialiased max-[600px]:pb-[84px] [--lp-bg-800:#101318] [--lp-bg-900:#0a0c10] [--lp-border:rgba(255,255,255,0.10)] [--lp-text-100:#f5f7f8] [--lp-text-300:#8b94a0] [--lp-wa-deep:#128c7e] [--lp-wa:#25d366] [&_:focus-visible]:rounded-[6px] [&_:focus-visible]:[outline-offset:3px] [&_:focus-visible]:[outline:2px_solid_#25d366]`}
    >
      {/* ============ NAV ============ */}
      <nav
        className="sticky top-0 z-50 border-b border-white/[0.07] bg-[rgba(5,6,7,0.78)] backdrop-blur-[12px]"
        aria-label="Primary"
      >
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-6 px-5 py-3">
          <a
            className="inline-flex items-center gap-2 text-[18px] font-bold tracking-[-0.02em]"
            href="#top"
          >
            <span className="text-[17px] text-[#25d366]" aria-hidden="true">
              ◈
            </span>
            SmartRemit
          </a>
          <div className="ml-auto flex items-center gap-6">
            <a
              className="text-[14px] text-[#8b94a0] transition-colors hover:text-[#f5f7f8] max-[760px]:hidden"
              href="#inside"
            >
              What&rsquo;s inside
            </a>
            <a
              className="text-[14px] text-[#8b94a0] transition-colors hover:text-[#f5f7f8] max-[760px]:hidden"
              href="#calculator"
            >
              Calculator
            </a>
            <LoginMenu />
            <a
              className="inline-flex min-h-10 items-center rounded-full border border-white/15 px-4 text-[13.5px] font-semibold text-[#f5f7f8] transition-[border-color,background-color] duration-150 hover:border-white/40 hover:bg-white/[0.04] max-[920px]:hidden"
              href="/account/register"
            >
              Create account
            </a>
            <a
              className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[#25d366] px-4 text-[13.5px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]"
              href={genericHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <WhatsAppIcon size={16} />
              <span>Start on WhatsApp</span>
            </a>
          </div>
        </div>
      </nav>

      <main id="top">
        {/* ============ HERO — the animated money pipeline ============ */}
        <section className="relative overflow-hidden px-5 pt-[clamp(56px,9vw,120px)] pb-[clamp(48px,7vw,96px)]">
          <div
            className="pointer-events-none absolute -inset-[30%] z-0 bg-[radial-gradient(38%_38%_at_30%_20%,rgba(37,211,102,0.13),transparent_70%),radial-gradient(42%_42%_at_75%_30%,rgba(34,211,238,0.10),transparent_70%)] blur-[12px] motion-safe:[animation-direction:alternate] motion-safe:[animation-duration:28s] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-name:lp-aurora] motion-safe:[animation-timing-function:ease-in-out]"
            aria-hidden="true"
          />
          <div className="relative z-[1] mx-auto w-full max-w-[1180px]">
            <div className="mx-auto max-w-[840px] text-center">
              <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-[12.5px] font-medium text-[#8b94a0]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#25d366]" aria-hidden="true" />
                Non-custodial remittance infrastructure · WhatsApp-native
              </p>
              <h1 className="text-balance text-[clamp(38px,7vw,76px)] font-semibold leading-[1.05] tracking-[-0.03em]">
                Send money by chatting.{' '}
                <span className="bg-[linear-gradient(95deg,#25d366,#22d3ee)] bg-clip-text text-transparent">
                  Watch it arrive.
                </span>
              </h1>
              <p className="mx-auto mt-6 max-w-[56ch] text-[clamp(16px,2vw,19px)] leading-relaxed text-[#8b94a0]">
                An AI agent quotes the live mid-market rate in WhatsApp, a hosted page takes
                payment, and a licensed partner settles — every step signed, screened, and
                audited.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
                <a
                  className={`${BTN_WA} max-[480px]:w-full`}
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WhatsAppIcon size={20} />
                  <span>Start on WhatsApp</span>
                </a>
                <a className={`${BTN_GHOST} max-[480px]:w-full`} href="#inside">
                  See how it works
                </a>
              </div>
            </div>

            <div className={`mt-[clamp(44px,6vw,80px)] ${RISE}`}>
              <HeroPipeline liveRate={liveRate} />
            </div>
          </div>
        </section>

        {/* ============ TRUST BAND ============ */}
        <section
          aria-label="Why you can trust SmartRemit"
          className="border-y border-white/[0.07] bg-white/[0.02]"
        >
          <ul className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-center gap-x-10 gap-y-3 px-5 py-5 text-[13.5px] text-[#aeb6c0]">
            <li className="inline-flex items-center gap-2.5">
              <BankIcon /> Non-custodial by design
            </li>
            <li className="inline-flex items-center gap-2.5">
              <BadgeIcon /> Licensed-partner settled
            </li>
            <li className="inline-flex items-center gap-2.5">
              <ShieldIcon /> Sanctions screening on every transfer
            </li>
            <li className="inline-flex items-center gap-2.5">
              <AuditIcon /> Full audit trail
            </li>
          </ul>
        </section>

        {/* ============ WHAT'S INSIDE — product showcase ============ */}
        <section id="inside" className="px-5 py-[clamp(64px,9vw,140px)]" aria-labelledby="inside-h">
          <div className="mx-auto w-full max-w-[1180px]">
            <div className={`mx-auto max-w-[680px] text-center ${RISE}`}>
              <h2
                id="inside-h"
                className="text-[clamp(30px,4.5vw,52px)] font-semibold leading-[1.08] tracking-[-0.025em]"
              >
                What&rsquo;s inside.
              </h2>
              <p className="mt-4 text-[17px] text-[#8b94a0]">
                The same system, surface by surface.
              </p>
            </div>

            <div className="mt-[clamp(48px,6vw,88px)] flex flex-col gap-[clamp(64px,8vw,120px)]">
              {/* (a) The conversation */}
              <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-20 ${RISE}`}>
                <div>
                  <p className={`${EYEBROW} text-[#25d366]`}>
                    01 — The conversation
                  </p>
                  <h3 className={SHOWCASE_H3}>
                    An agent that speaks money.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Quote, KYC, approval, receipt — the entire transfer is a conversation. The
                    agent locks the live mid-market rate and holds it for you. It never holds
                    your funds.
                  </p>
                </div>
                <ChatMock liveRate={liveRate} />
              </div>

              {/* (b) The ops dashboard */}
              <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-20 ${RISE}`}>
                <div className="lg:order-2">
                  <p className={`${EYEBROW} text-[#22d3ee]`}>
                    02 — The ops dashboard
                  </p>
                  <h3 className={SHOWCASE_H3}>
                    Every transfer, observable.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Staff watch money move in real time — live transfers, a compliance review
                    queue, FX analytics. PII stays encrypted at rest, and every reveal is
                    written to the audit log.
                  </p>
                </div>
                <div className="lg:order-1">
                  <OpsMock />
                </div>
              </div>

              {/* (c) The partner rail */}
              <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-20 ${RISE}`}>
                <div>
                  <p className={`${EYEBROW} text-[#25d366]`}>
                    03 — The partner rail
                  </p>
                  <h3 className={SHOWCASE_H3}>
                    Your rail. Our orchestration.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Settlement is an instruction, not a balance. SmartRemit signs an
                    instruction to your rail and verifies the signed callback — funds never
                    touch us. A REST API and hosted reference rail ship with it.
                  </p>
                </div>
                <RailMock />
              </div>

              {/* (d) The AI layer */}
              <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-20 ${RISE}`}>
                <div className="lg:order-2">
                  <p className={`${EYEBROW} text-[#22d3ee]`}>
                    04 — The AI layer
                  </p>
                  <h3 className={SHOWCASE_H3}>
                    One AI layer, two sides.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Customers get an agent that answers in plain language. The platform runs
                    compliance on every transfer — sanctions screening is structurally
                    impossible to switch off, in every KYC mode.
                  </p>
                </div>
                <div className="lg:order-1">
                  <AiMock />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============ CORRIDORS ============ */}
        <section
          id="corridors"
          className={`border-t border-white/[0.07] px-5 py-[clamp(56px,8vw,110px)] ${RISE}`}
          aria-labelledby="corridors-h"
        >
          <div className="mx-auto w-full max-w-[1180px] text-center">
            <h2
              id="corridors-h"
              className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
            >
              8 corridors. Any direction.
            </h2>
            <p className="mt-4 text-[16px] text-[#8b94a0]">
              Send and receive between all of these — tap a country to start the chat.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              {COUNTRIES.map((c) => (
                <a
                  key={c.short}
                  className="inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.03] py-2 pr-4 pl-2.5 transition-[border-color,background-color,transform] duration-150 hover:border-[rgba(37,211,102,0.5)] hover:bg-[rgba(37,211,102,0.07)] hover:[transform:translateY(-2px)]"
                  href={waLink(corridorMessage(c.name))}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="block h-auto w-7 rounded-[4px] bg-white/[0.08]"
                    src={`/flags/${c.code}.svg`}
                    alt=""
                    width={28}
                    height={21}
                    loading="lazy"
                  />
                  <span className="text-[14px] font-semibold text-[#f5f7f8]">{c.short}</span>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* ============ LIVE FX CALCULATOR ============ */}
        <section
          id="calculator"
          className={`border-t border-white/[0.07] px-5 py-[clamp(64px,9vw,130px)] ${RISE}`}
          aria-labelledby="calculator-h"
        >
          <div className="mx-auto grid w-full max-w-[1080px] items-center gap-10 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className={`${EYEBROW} text-[#25d366]`}>
                Live FX
              </p>
              <h2
                id="calculator-h"
                className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
              >
                The honest rate, before you send.
              </h2>
              <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#f5f7f8]">
                Today, 1 USD = {fmtRate(liveRate)}{' '}
                <span className="text-[#8b94a0]">(live mid-market rate).</span>
              </p>
              <p className="mt-2 max-w-[46ch] text-[15px] leading-relaxed text-[#8b94a0]">
                No markup baked into the rate — your first transfer is free, then a flat $1.99
                per bank transfer.
              </p>
            </div>
            <RateCalculator liveRate={liveRate} />
          </div>
        </section>

        {/* ============ FINAL CTA ============ */}
        <section
          className={`relative overflow-hidden border-t border-white/[0.07] px-5 py-[clamp(72px,10vw,150px)] text-center ${RISE}`}
          aria-labelledby="final-h"
        >
          <div
            className="pointer-events-none absolute -inset-[30%] z-0 bg-[radial-gradient(40%_40%_at_35%_45%,rgba(37,211,102,0.14),transparent_70%),radial-gradient(45%_45%_at_70%_55%,rgba(34,211,238,0.10),transparent_70%)] blur-[12px] motion-safe:[animation-direction:alternate] motion-safe:[animation-duration:28s] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-name:lp-aurora] motion-safe:[animation-timing-function:ease-in-out]"
            aria-hidden="true"
          />
          <div className="relative z-[1] mx-auto w-full max-w-[760px]">
            <h2
              id="final-h"
              className="text-balance text-[clamp(30px,4.5vw,54px)] font-semibold leading-[1.08] tracking-[-0.025em]"
            >
              Your family is one message away.
            </h2>
            <p className="mt-5 text-[17px] text-[#8b94a0]">
              Send money home in the time it takes to type a text.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
              <a
                className={`${BTN_WA} max-[480px]:w-full`}
                href={genericHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                <WhatsAppIcon size={20} />
                <span>Start on WhatsApp</span>
              </a>
            </div>
            <p className="mt-8 text-[14px] text-[#8b94a0]">
              Building a remittance product?{' '}
              <a className="font-semibold text-[#22d3ee] hover:underline" href="/docs">
                Read the partner docs →
              </a>
            </p>
          </div>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-white/10 bg-[#07090b] pt-[clamp(40px,6vw,64px)] pb-8">
        <div className="mx-auto grid w-full max-w-[1180px] grid-cols-4 gap-8 px-5 max-[760px]:grid-cols-2">
          <div>
            <span className={FOOT_HEAD}>
              Product
            </span>
            <ul className={FOOT_LIST}>
              <li>
                <a className="hover:text-[#f5f7f8]" href="#inside">
                  What&rsquo;s inside
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="#corridors">
                  Corridors
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="#calculator">
                  FX calculator
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/docs">
                  Partner docs
                </a>
              </li>
            </ul>
          </div>
          <div>
            <span className={FOOT_HEAD}>
              Log in
            </span>
            <ul className={FOOT_LIST}>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/account/login">
                  Customers
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/login">
                  Employee portal
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/docs">
                  Partners
                </a>
              </li>
            </ul>
          </div>
          <div>
            <span className={FOOT_HEAD}>
              Account
            </span>
            <ul className={FOOT_LIST}>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/account/register">
                  Create account
                </a>
              </li>
              <li>
                <a className="hover:text-[#f5f7f8]" href="/account/login">
                  Customer portal
                </a>
              </li>
            </ul>
          </div>
          <div>
            <span className={FOOT_HEAD}>
              Contact
            </span>
            <ul className={FOOT_LIST}>
              <li>
                <a
                  className="hover:text-[#f5f7f8]"
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  WhatsApp: +1 555 629 8293
                </a>
              </li>
              {/* PLACEHOLDER: replace with a real support email address. */}
              <li>Email: [PLACEHOLDER support email]</li>
            </ul>
          </div>
        </div>
        <div className="mx-auto mt-10 w-full max-w-[1180px] border-t border-white/[0.07] px-5 pt-6">
          {/* PLACEHOLDER: real licensing & regulatory disclosures go here. Do
              NOT add fabricated regulatory badges or licence numbers. */}
          <p className="max-w-[90ch] text-[12.5px] leading-relaxed text-[#5b6470]">
            SmartRemit is a demonstration money-transfer service. [PLACEHOLDER: licensing
            &amp; regulatory disclosures]. Non-custodial by design: SmartRemit provides the
            technology platform — conversation, quoting, compliance screening, and
            orchestration. Partners are the licensed money transmitters and settle all funds
            on their own rails; SmartRemit never holds, receives, or disburses customer
            money. Exchange rates are indicative and locked when you confirm a transfer.
          </p>
          <p className="mt-5 text-[13.5px] text-[#8b94a0]">
            <span className="text-[16px] text-[#25d366]" aria-hidden="true">
              ◈
            </span>{' '}
            SmartRemit · smartremit.ai — Send money by chatting. Watch it arrive.
          </p>
        </div>
      </footer>

      {/* ============ MOBILE STICKY CTA (≤600px only, via CSS) ============ */}
      <a
        className="fixed inset-x-3 bottom-3 z-[60] hidden min-h-[52px] items-center justify-center gap-2.5 rounded-full bg-[#25d366] px-[22px] pt-[13px] pb-[calc(13px+env(safe-area-inset-bottom))] text-[16px] font-bold text-[#04231a] shadow-[0_10px_30px_-10px_rgba(37,211,102,0.65)] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] max-[600px]:flex"
        href={genericHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        <WhatsAppIcon size={20} />
        <span>Start on WhatsApp</span>
      </a>
    </div>
  );
}
