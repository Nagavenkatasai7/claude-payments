import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { getFxRate, FALLBACK_FX_RATE } from '@/lib/rate';
import {
  waLink,
  WA_MESSAGES,
  corridorMessage,
} from './landing/wa';
import WhatsAppIcon from './landing/WhatsAppIcon';
import { LockIcon, RateIcon, GlobeIcon, BankIcon } from './landing/TrustIcons';
import RateCalculator from './landing/RateCalculator';
import TiltCard from './landing/TiltCard';

// Self-hosted Inter, scoped to the landing tree only (applied on the landing
// root div), so it never touches the sh-* dashboard or .payapp themes.
const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'SmartRemit — Send money home, right from WhatsApp',
  description:
    'Send money bank-to-bank across 8 countries, any direction, at live exchange rates — all inside WhatsApp. No app to download. First transfer free.',
  openGraph: {
    title: 'SmartRemit — Send money home, right from WhatsApp',
    description:
      'Send money bank-to-bank across 8 countries, any direction, at live exchange rates — all inside WhatsApp.',
    type: 'website',
  },
};

// Rate refreshes hourly; getFxRate() already caches for 1h, so the page stays
// fast and mostly static.
export const revalidate = 3600;

// `code` = ISO-3166 alpha-2, used to pick a self-hosted flag SVG from /public/flags
// (renders as a real flag in every browser; emoji flags don't render in Chrome/Arc
// on macOS/Windows, and self-hosting removes the runtime dependency on flagcdn.com).
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

function fmtRate(rate: number): string {
  return '₹' + rate.toFixed(2);
}

function fmtInr(n: number): string {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

export default async function LandingPage() {
  // getFxRate() never throws (internal try/catch → fallback 85), but wrap
  // defensively so the page can never error if FX is down.
  let liveRate = FALLBACK_FX_RATE;
  try {
    const r = await getFxRate();
    if (Number.isFinite(r) && r > 0) liveRate = r;
  } catch {
    liveRate = FALLBACK_FX_RATE;
  }

  const heroInr = fmtInr(500 * liveRate);
  const genericHref = waLink(WA_MESSAGES.generic);

  return (
    // The [--lp-*] custom properties bridge the still-unconverted landing child
    // components (RateCalculator, WhatsAppIcon) whose legacy lp-* CSS rules
    // consume them; delete the declarations once those components go Tailwind.
    <div
      className={`${inter.className} min-h-svh overflow-x-hidden bg-[#0A1124] leading-[1.65] text-[#F5F8FF] antialiased max-[600px]:pb-[84px] [--lp-bg-800:#0F1B3D] [--lp-bg-900:#0A1124] [--lp-border:rgba(255,255,255,0.10)] [--lp-text-100:#F5F8FF] [--lp-text-300:#AAB7D4] [--lp-wa-deep:#128C7E] [--lp-wa:#25D366] [&_:focus-visible]:rounded-[6px] [&_:focus-visible]:[outline-offset:3px] [&_:focus-visible]:[outline:2px_solid_#25D366]`}
    >
      {/* Sentinel for the frosted-nav IntersectionObserver. */}

      {/* ============ NAV ============ */}
      {/* The frosted treatment is now static: NavScroll's `.lp-nav` hook went
          inert with the lp-* classes, so the nav keeps its scrolled look at
          all scroll positions (the at-top hero behind it is equally dark). */}
      <nav
        className="sticky top-0 z-50 flex items-center gap-4 border-b border-[rgba(255,255,255,0.10)] bg-[rgba(15,27,61,0.82)] px-5 py-3.5 backdrop-blur-[10px] max-[600px]:gap-2.5 max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none"
        aria-label="Primary"
      >
        <a className="inline-flex items-center gap-2 text-[19px] font-extrabold tracking-[-0.01em]" href="#top">
          <span className="text-[18px] text-[#25D366]" aria-hidden="true">
            ◈
          </span>
          SmartRemit
        </a>
        <div className="ml-auto flex gap-[26px] text-[15px] text-[#AAB7D4] max-[600px]:hidden">
          <a className="hover:text-[#F5F8FF]" href="#how">How it works</a>
          <a className="hover:text-[#F5F8FF]" href="#countries">Countries</a>
          <a className="hover:text-[#F5F8FF]" href="#faq">FAQ</a>
          <a className="hover:text-[#F5F8FF]" href="/account/login">Log in</a>
        </div>
        <a
          className="inline-flex min-h-11 items-center whitespace-nowrap rounded-[10px] border border-[rgba(255,255,255,0.10)] px-4 py-[9px] text-[14px] font-semibold text-[#F5F8FF] transition-[border-color,background] duration-200 ease-[ease] hover:border-[#F5F8FF] hover:bg-[rgba(255,255,255,0.04)] max-[600px]:hidden"
          href="/account/register"
        >
          Create account
        </a>
        <a
          className="ml-4 inline-flex min-h-11 items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-4 py-[9px] text-[14px] font-bold text-[#04231A] shadow-none transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)] max-[600px]:ml-auto"
          href={genericHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          <WhatsAppIcon size={18} />
          <span>Send on WhatsApp</span>
        </a>
      </nav>

      <main id="top">
        {/* ============ HERO ============ */}
        <section className="relative overflow-hidden pt-[clamp(48px,8vw,96px)] pb-[clamp(56px,8vw,110px)]">
          <div
            className="pointer-events-none absolute -inset-[25%] z-0 bg-[radial-gradient(40%_40%_at_20%_25%,rgba(37,211,102,0.22),transparent_70%),radial-gradient(45%_45%_at_80%_20%,rgba(14,165,233,0.22),transparent_70%),radial-gradient(50%_50%_at_60%_80%,rgba(79,70,229,0.20),transparent_70%)] blur-[10px] motion-safe:[animation-direction:alternate] motion-safe:[animation-duration:26s] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-name:lp-aurora] motion-safe:[animation-timing-function:ease-in-out] max-[600px]:-inset-[10%] max-[600px]:bg-[radial-gradient(60%_50%_at_50%_30%,rgba(37,211,102,0.2),transparent_70%)] motion-safe:max-[600px]:[animation-duration:40s]"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 z-0 bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27120%27%20height=%27120%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%27.9%27%20numOctaves=%272%27/%3E%3C/filter%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20filter=%27url(%23n)%27/%3E%3C/svg%3E')] opacity-[0.04]"
            aria-hidden="true"
          />
          <div className="relative z-[1] mx-auto grid w-full max-w-[1120px] grid-cols-[1.05fr_.95fr] items-center gap-[clamp(28px,5vw,64px)] px-5 max-[1024px]:grid-cols-1">
            <div className="max-[1024px]:order-1">
              <h1 className="mb-[18px] text-[clamp(33px,6vw,56px)] leading-[1.08] font-extrabold tracking-[-0.02em]">
                Send money home.{' '}
                <span className="text-[#25D366] supports-[background-clip:text]:bg-[linear-gradient(100deg,#25D366,#0EA5E9)] supports-[background-clip:text]:bg-clip-text supports-[background-clip:text]:text-transparent">Right from WhatsApp.</span>
              </h1>
              <p className="mb-7 max-w-[33ch] text-[clamp(16px,2.2vw,20px)] text-[#AAB7D4] max-[600px]:max-w-none">
                No app to download, no forms to fill. Just chat with our
                assistant and money lands in their bank — across 8 countries, any
                direction, at live exchange rates.
              </p>
              <div className="mb-[18px]">
                <a
                  className="inline-flex min-h-14 items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-7 py-4 text-[18px] font-bold text-[#04231A] shadow-[0_10px_26px_-10px_rgba(37,211,102,0.6)] transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)] max-[600px]:w-full"
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WhatsAppIcon size={22} />
                  <span>Send money on WhatsApp</span>
                </a>
                <p className="mt-3 text-[13.5px] text-[#AAB7D4]">
                  No app to install · Live mid-market-style rate · Money
                  bank-to-bank
                </p>
              </div>
              <p className="inline-flex items-center gap-1.5 text-[13.5px] text-[#AAB7D4]">
                Bank-grade encryption · 8 countries, any direction
              </p>
            </div>

            {/* Glass WhatsApp chat mock */}
            <TiltCard
              className="relative w-full max-w-[360px] justify-self-center [perspective:1000px] [transform-style:preserve-3d] max-[1024px]:order-2 max-[1024px]:mt-2 max-[600px]:transform-none!"
              max={5}
            >
              <div
                className="relative z-[2] overflow-hidden rounded-[22px] border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.07)] pb-4 shadow-[0_30px_60px_-20px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-[10px] [transform-style:preserve-3d] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none"
                role="img"
                aria-label="Example WhatsApp chat with the SmartRemit assistant quoting a transfer of $500 to India"
              >
                <div className="flex items-center gap-2.5 border-b border-[rgba(255,255,255,0.10)] bg-[rgba(18,140,126,0.35)] px-4 py-3.5">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-[#25D366] text-[15px] text-[#04231A]" aria-hidden="true">
                    ◈
                  </span>
                  <span className="text-[15px] font-bold">SmartRemit</span>
                  <span className="ml-auto text-[12px] text-[#10B981]">online</span>
                </div>
                <div className="flex flex-col gap-2.5 px-4 pt-[18px] pb-1">
                  <div className="max-w-[85%] self-start rounded-[14px] rounded-bl-[4px] bg-[#16244F] px-[13px] py-2.5 text-[14.5px] leading-[1.45]">
                    How much would you like to send?
                  </div>
                  <div className="max-w-[85%] self-end rounded-[14px] rounded-br-[4px] bg-[#128C7E] px-[13px] py-2.5 text-[14.5px] leading-[1.45] text-[#F5F8FF]">
                    Send $500 to my brother in India
                  </div>
                  <div className="max-w-[85%] self-start rounded-[14px] rounded-bl-[4px] border border-[rgba(37,211,102,0.35)] bg-[linear-gradient(145deg,#16244F,#0F1B3D)] px-[13px] py-2.5 text-[14.5px] leading-[1.45] [&_strong]:text-[16px] [&_strong]:text-[#25D366]">
                    <strong>$500 → {heroInr}</strong>
                    <br />
                    rate 1 USD = {fmtRate(liveRate)} · fee $0 first transfer ·
                    arrives within minutes
                  </div>
                  <div className="max-w-[85%] self-start rounded-[14px] rounded-bl-[4px] bg-[#16244F] px-[13px] py-2.5 text-[14.5px] leading-[1.45] font-semibold text-[#10B981]">
                    Delivered ✓
                  </div>
                </div>
              </div>
              <div
                className="absolute -top-3.5 -right-1.5 z-[3] inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(15,27,61,0.9)] px-[13px] py-2 text-[13px] font-semibold text-[#10B981] shadow-[0_12px_28px_-14px_rgba(0,0,0,0.8)] [transform:translateZ(40px)]"
                aria-hidden="true"
              >
                <span className="h-2 w-2 rounded-full bg-[#10B981] shadow-[0_0_0_4px_rgba(16,185,129,0.2)]" /> FX live
              </div>
              <div
                className="absolute bottom-[26px] -left-3.5 z-[3] inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(15,27,61,0.9)] px-[13px] py-2 text-[13px] font-semibold text-[#0EA5E9] shadow-[0_12px_28px_-14px_rgba(0,0,0,0.8)] [transform:translateZ(60px)]"
                aria-hidden="true"
              >
                8 countries
              </div>
            </TiltCard>
          </div>
        </section>

        {/* ============ LIVE RATE STRIP / CALCULATOR ============ */}
        <section
          className="py-[clamp(40px,6vw,72px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="rate-h"
        >
          <div className="mx-auto grid w-full max-w-[1120px] grid-cols-2 items-center gap-[clamp(24px,4vw,48px)] px-5 max-[1024px]:grid-cols-1">
            <div>
              <h2 id="rate-h" className="mb-3.5 text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
                See the real rate before you send a cent.
              </h2>
              <p className="text-[18px] text-[#F5F8FF]">
                Today, 1 USD = {fmtRate(liveRate)}{' '}
                <span className="text-[#AAB7D4]">(live mid-market rate).</span>
              </p>
            </div>
            <RateCalculator liveRate={liveRate} />
          </div>
        </section>

        {/* ============ TRUST BAR ============ */}
        <section
          className="pt-2 pb-9 motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-label="Why you can trust SmartRemit"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <ul className="flex flex-wrap justify-center gap-3">
              <li className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-[14px] text-[#F5F8FF]">
                <LockIcon /> Bank-grade encryption
              </li>
              <li className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-[14px] text-[#F5F8FF]">
                <RateIcon /> Live exchange rates
              </li>
              <li className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-[14px] text-[#F5F8FF]">
                <GlobeIcon /> 8 countries · any direction
              </li>
              <li className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-[14px] text-[#F5F8FF]">
                <BankIcon /> Money bank-to-bank
              </li>
            </ul>
            {/* PLACEHOLDER: replace these grey slots with real press/partner logos. */}
            <div className="mt-[26px] text-center" aria-label="As featured in — placeholder press logos">
              <span className="mb-3 block text-[12px] uppercase tracking-[0.08em] text-[#AAB7D4]">As featured in</span>
              <div className="flex flex-wrap justify-center gap-4">
                <span className="h-[34px] w-[110px] rounded-lg bg-[linear-gradient(90deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] opacity-50 grayscale" />
                <span className="h-[34px] w-[110px] rounded-lg bg-[linear-gradient(90deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] opacity-50 grayscale" />
                <span className="h-[34px] w-[110px] rounded-lg bg-[linear-gradient(90deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] opacity-50 grayscale" />
                <span className="h-[34px] w-[110px] rounded-lg bg-[linear-gradient(90deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] opacity-50 grayscale" />
              </div>
            </div>
          </div>
        </section>

        {/* ============ WHY SMARTREMIT ============ */}
        <section
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="value-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="value-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              A better way to send money to family.
            </h2>
            <div className="mt-9 grid grid-cols-4 gap-[18px] max-[1024px]:grid-cols-2 max-[600px]:grid-cols-1">
              <TiltCard className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">It&rsquo;s just WhatsApp.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  No app, no signup forms, no waiting room. Chat the way you
                  already do, and you&rsquo;re done.
                </p>
              </TiltCard>
              <TiltCard className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">The honest rate.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Banks bury their margin in a bad exchange rate. We show you the
                  real rate and the exact fee, every time.
                </p>
              </TiltCard>
              <TiltCard className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">Lands in minutes.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Money goes straight to their bank account — typically within
                  minutes, not days.
                </p>
              </TiltCard>
              <TiltCard className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">Send anywhere, both ways.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  US, Canada, UK, UAE, Singapore, Australia, New Zealand, India
                  — any direction.
                </p>
              </TiltCard>
            </div>
          </div>
        </section>

        {/* ============ HOW IT WORKS ============ */}
        <section
          id="how"
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="how-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="how-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              Send money in three messages.
            </h2>
            <ol className="mt-9 grid grid-cols-3 gap-[18px] max-[600px]:grid-cols-1 max-[600px]:gap-7">
              <li className="relative rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] px-6 pt-[30px] pb-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <span className="absolute -top-4 left-6 grid h-[38px] w-[38px] place-items-center rounded-full bg-[linear-gradient(145deg,#25D366,#128C7E)] text-[17px] font-extrabold text-[#04231A] shadow-[0_8px_20px_-8px_rgba(37,211,102,0.7)] [transform:translateZ(20px)]" aria-hidden="true">
                  1
                </span>
                <h3 className="mb-2 text-[19px] font-bold">Open WhatsApp.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Tap the button. A chat with our assistant opens — no download,
                  no account to create.
                </p>
              </li>
              <li className="relative rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] px-6 pt-[30px] pb-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <span className="absolute -top-4 left-6 grid h-[38px] w-[38px] place-items-center rounded-full bg-[linear-gradient(145deg,#25D366,#128C7E)] text-[17px] font-extrabold text-[#04231A] shadow-[0_8px_20px_-8px_rgba(37,211,102,0.7)] [transform:translateZ(20px)]" aria-hidden="true">
                  2
                </span>
                <h3 className="mb-2 text-[19px] font-bold">Tell us who and how much.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Just their name, their number, and the amount. We lock in the
                  live rate and show you the fee up front.
                </p>
              </li>
              <li className="relative rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] px-6 pt-[30px] pb-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <span className="absolute -top-4 left-6 grid h-[38px] w-[38px] place-items-center rounded-full bg-[linear-gradient(145deg,#25D366,#128C7E)] text-[17px] font-extrabold text-[#04231A] shadow-[0_8px_20px_-8px_rgba(37,211,102,0.7)] [transform:translateZ(20px)]" aria-hidden="true">
                  3
                </span>
                <h3 className="mb-2 text-[19px] font-bold">They get paid.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Approve with one tap. Money lands in their bank account,
                  bank-to-bank.
                </p>
              </li>
            </ol>
            <div className="mt-[34px] flex flex-wrap items-center justify-center gap-[18px]">
              <p className="text-[17px] text-[#F5F8FF]">That&rsquo;s it — no app, no paperwork.</p>
              <a
                className="inline-flex min-h-12 items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-[22px] py-[13px] text-[16px] font-bold text-[#04231A] shadow-[0_10px_26px_-10px_rgba(37,211,102,0.6)] transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)]"
                href={genericHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                <WhatsAppIcon size={18} />
                <span>Start on WhatsApp</span>
              </a>
            </div>
          </div>
        </section>

        {/* ============ CORRIDORS / COUNTRIES ============ */}
        <section
          id="countries"
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="corr-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="corr-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              8 countries. Any direction.
            </h2>
            <p className="mb-7 text-center text-[17px] text-[#AAB7D4]">
              Send and receive between all of these — pick your route and start a
              chat.
            </p>
            <div className="mt-9 grid grid-cols-[1.4fr_1fr] gap-[18px] [grid-template-areas:'map_tiles'_'facts_tiles'] max-[1024px]:grid-cols-1 max-[1024px]:[grid-template-areas:'map'_'tiles'_'facts']">
              <div
                className="relative flex min-h-[220px] flex-col rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-[18px] shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] [grid-area:map] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none"
                role="img"
                aria-label="A route map connecting the 8 supported countries — United States, Canada, United Kingdom, UAE, Singapore, Australia, New Zealand and India — with money able to flow in any direction between them."
              >
                <svg
                  viewBox="0 0 400 220"
                  className="aspect-[400/220] h-auto w-full"
                  aria-hidden="true"
                  preserveAspectRatio="xMidYMid meet"
                >
                  <defs>
                    <radialGradient id="lp-node" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#25D366" />
                      <stop offset="100%" stopColor="#128C7E" />
                    </radialGradient>
                  </defs>
                  {/* arcs */}
                  {[
                    [60, 60, 340, 60],
                    [60, 60, 200, 170],
                    [340, 60, 200, 170],
                    [60, 160, 340, 160],
                    [200, 40, 200, 170],
                    [90, 110, 320, 120],
                  ].map(([x1, y1, x2, y2], i) => (
                    <path
                      key={i}
                      d={`M${x1} ${y1} Q ${(x1 + x2) / 2} ${
                        Math.min(y1, y2) - 30
                      } ${x2} ${y2}`}
                      fill="none"
                      stroke="rgba(14,165,233,.45)"
                      strokeWidth="1.5"
                    />
                  ))}
                  {[
                    [60, 60],
                    [340, 60],
                    [200, 40],
                    [90, 110],
                    [320, 120],
                    [60, 160],
                    [340, 160],
                    [200, 170],
                  ].map(([cx, cy], i) => (
                    <circle key={i} cx={cx} cy={cy} r="6" fill="url(#lp-node)" />
                  ))}
                </svg>
                <span className="mt-auto text-[13px] text-[#AAB7D4]">Any route, both ways</span>
              </div>

              <div className="grid grid-cols-2 gap-3 [grid-area:tiles] max-[1024px]:grid-cols-4 max-[600px]:grid-cols-2">
                {COUNTRIES.map((c) => (
                  <a
                    key={c.short}
                    className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-2 py-4 text-center transition-[transform,border-color,background] duration-[160ms] ease-[ease] hover:border-[rgba(37,211,102,0.5)] hover:bg-[rgba(37,211,102,0.08)] hover:[transform:translateY(-2px)]"
                    href={waLink(corridorMessage(c.name))}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="block h-auto w-[38px] rounded-[5px] bg-[rgba(255,255,255,0.08)] shadow-[0_3px_9px_rgba(0,0,0,0.38)]"
                      src={`/flags/${c.code}.svg`}
                      alt=""
                      width={36}
                      height={27}
                      loading="lazy"
                    />
                    <span className="text-[13.5px] font-semibold text-[#F5F8FF]">{c.short}</span>
                  </a>
                ))}
              </div>

              <div className="flex flex-wrap content-start gap-2.5 [grid-area:facts]">
                <span className="rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-3.5 py-[9px] text-[13.5px] font-semibold text-[#F5F8FF]">Live FX</span>
                <span className="rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-3.5 py-[9px] text-[13.5px] font-semibold text-[#F5F8FF]">Bank-to-bank</span>
                <span className="rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-3.5 py-[9px] text-[13.5px] font-semibold text-[#F5F8FF]">Minutes, not days</span>
                <span className="rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] px-3.5 py-[9px] text-[13.5px] font-semibold text-[#F5F8FF]">WhatsApp-native</span>
              </div>
            </div>
          </div>
        </section>

        {/* ============ TRANSPARENT PRICING ============ */}
        <section
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="price-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="price-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              What you see is what you send.
            </h2>
            <p className="mb-7 text-center text-[17px] text-[#AAB7D4]">
              No hidden markup baked into the rate. Just the live exchange rate
              plus a clear, flat fee.
            </p>
            <div className="mt-9 grid grid-cols-[1.3fr_1fr] gap-[18px] max-[1024px]:grid-cols-1">
              <div className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-[26px] shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <div className="mb-4 flex items-center gap-3.5">
                  <span className="w-24 flex-[0_0_96px] text-[13.5px] font-semibold">SmartRemit</span>
                  <div className="flex h-10 min-w-max items-center overflow-hidden rounded-[10px] bg-[linear-gradient(90deg,#25D366,#128C7E)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[#04231A] max-[600px]:h-auto max-[600px]:min-h-10 max-[600px]:min-w-0 max-[600px]:px-3 max-[600px]:py-2 max-[600px]:leading-[1.25] max-[600px]:whitespace-normal" style={{ width: '32%' }}>
                    <span>live rate + $1.99 flat fee</span>
                  </div>
                </div>
                <div className="mb-4 flex items-center gap-3.5">
                  <span className="w-24 flex-[0_0_96px] text-[13.5px] font-semibold">Typical bank</span>
                  <div className="flex h-10 min-w-max items-center overflow-hidden rounded-[10px] bg-[linear-gradient(90deg,rgba(255,255,255,0.14),rgba(255,255,255,0.06))] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[#F5F8FF] max-[600px]:h-auto max-[600px]:min-h-10 max-[600px]:min-w-0 max-[600px]:px-3 max-[600px]:py-2 max-[600px]:leading-[1.25] max-[600px]:whitespace-normal" style={{ width: '88%' }}>
                    <span>rate marked up 3–5% + fees</span>
                  </div>
                </div>
                <p className="mt-1.5 text-[12px] text-[#AAB7D4]">
                  Illustrative example — your bank&rsquo;s markup may vary.
                </p>
              </div>
              <div className="flex flex-col gap-3 rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-[26px] shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <p className="text-[20px] text-[#F5F8FF] [font-weight:750]">
                  Your first transfer is free.
                </p>
                <p className="text-[15px] text-[#AAB7D4]">
                  After that, $1.99 per bank transfer. Send $10 to $2,999 per
                  transfer.
                </p>
                <a
                  className="mt-auto inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-[22px] py-[13px] text-[16px] font-bold text-[#04231A] shadow-[0_10px_26px_-10px_rgba(37,211,102,0.6)] transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)]"
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WhatsAppIcon size={18} />
                  <span>Send money on WhatsApp</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ============ TRUST & SAFETY ============ */}
        <section
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="safety-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="safety-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              Built to be trusted with your money.
            </h2>
            <div className="mt-9 grid grid-cols-3 gap-[18px] max-[600px]:grid-cols-1">
              <div className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">Encrypted end to end.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Your conversation runs over WhatsApp&rsquo;s encryption, and
                  your data is never sold or shared.
                </p>
              </div>
              <div className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">Transparent by design.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  You see the rate, the fee, and exactly what your recipient gets
                  — before you confirm. Nothing moves until you tap approve.
                </p>
              </div>
              <div className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <h3 className="mb-2 text-[19px] font-bold">Bank-to-bank, every time.</h3>
                <p className="text-[15px] text-[#AAB7D4]">
                  Funds go directly between bank accounts. We never ask for card
                  details in chat.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ============ WHY US — real product promises ============ */}
        {/* Pre-launch: no real customers yet, so we show true product promises
            instead of inventing testimonials/names/ratings. Swap these for real,
            attributable customer quotes once they exist. */}
        <section
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="proof-h"
        >
          <div className="mx-auto w-full max-w-[1120px] px-5">
            <h2 id="proof-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              Built for families who send money home.
            </h2>
            <div className="mt-9 mb-6 grid grid-cols-3 gap-[18px] max-[600px]:grid-cols-1">
              <figure className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <blockquote className="mb-3 text-[15.5px] italic text-[#F5F8FF]">
                  The real mid-market exchange rate — one flat fee, never a hidden
                  markup on your rate.
                </blockquote>
                <figcaption className="text-[13.5px] text-[#AAB7D4]">Honest pricing</figcaption>
              </figure>
              <figure className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <blockquote className="mb-3 text-[15.5px] italic text-[#F5F8FF]">
                  Bank-grade identity verification and encrypted details keep every
                  transfer secure.
                </blockquote>
                <figcaption className="text-[13.5px] text-[#AAB7D4]">Verified &amp; protected</figcaption>
              </figure>
              <figure className="rounded-[18px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] p-6 shadow-[0_18px_40px_-22px_rgba(8,12,30,0.7),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-[10px] not-supports-[backdrop-filter:blur(1px)]:not-supports-[-webkit-backdrop-filter:blur(1px)]:bg-[#0F1B3D] max-[600px]:bg-[#0F1B3D] max-[600px]:backdrop-blur-none">
                <blockquote className="mb-3 text-[15.5px] italic text-[#F5F8FF]">
                  No new app to download — start a transfer right in the WhatsApp
                  chat you already use.
                </blockquote>
                <figcaption className="text-[13.5px] text-[#AAB7D4]">Right from WhatsApp</figcaption>
              </figure>
            </div>
            <p className="text-center text-[#AAB7D4]">
              We&rsquo;d love to earn your trust — try a first transfer free.
            </p>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section
          id="faq"
          className="py-[clamp(48px,7vw,90px)] motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="faq-h"
        >
          <div className="mx-auto w-full max-w-[760px] px-5">
            <h2 id="faq-h" className="mb-3.5 text-center text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              Questions, answered.
            </h2>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">Is it safe?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                Yes. Your chat runs over WhatsApp&rsquo;s encryption, money moves
                bank-to-bank, and nothing is sent until you approve it in the
                chat.
              </p>
            </details>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">What does it cost?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                Your first transfer is free. After that it&rsquo;s a flat $1.99
                per bank transfer, plus the live exchange rate — no hidden
                markup.
              </p>
            </details>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">How fast does it arrive?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                Most transfers land in the recipient&rsquo;s bank account within
                minutes.
              </p>
            </details>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">Which countries can I send to?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                US, Canada, UK, UAE, Singapore, Australia, New Zealand, and India
                — in any direction.
              </p>
            </details>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">Do I need to download an app?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                No. Everything happens inside WhatsApp, an app you almost
                certainly already have.
              </p>
            </details>
            <details className="group mt-3 overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[rgba(255,255,255,0.04)] first-of-type:mt-7">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-[18px] text-[16px] [font-weight:650] [&::-webkit-details-marker]:hidden after:font-normal after:text-[22px] after:text-[#25D366] after:content-['+'] group-open:after:content-['−']">What do I need to get started?</summary>
              <p className="px-5 pb-5 text-[15px] text-[#AAB7D4]">
                Just your recipient&rsquo;s name, their WhatsApp number, and how
                much you&rsquo;d like to send. You&rsquo;ll enter their bank
                details securely on the payment page — never in the chat.
              </p>
            </details>
          </div>
        </section>

        {/* ============ FINAL CTA BAND ============ */}
        <section
          className="relative overflow-hidden py-[clamp(56px,9vw,110px)] text-center motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_cover_40%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]"
          aria-labelledby="final-h"
        >
          <div
            className="pointer-events-none absolute -inset-[25%] z-0 bg-[radial-gradient(45%_45%_at_30%_40%,rgba(37,211,102,0.28),transparent_70%),radial-gradient(50%_50%_at_75%_55%,rgba(14,165,233,0.24),transparent_70%)] blur-[10px] motion-safe:[animation-direction:alternate] motion-safe:[animation-duration:26s] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-name:lp-aurora] motion-safe:[animation-timing-function:ease-in-out] max-[600px]:-inset-[10%] max-[600px]:bg-[radial-gradient(60%_50%_at_50%_30%,rgba(37,211,102,0.2),transparent_70%)] motion-safe:max-[600px]:[animation-duration:40s]"
            aria-hidden="true"
          />
          <div className="relative z-[1] mx-auto w-full max-w-[1120px] px-5">
            <h2 id="final-h" className="mb-3.5 text-[clamp(26px,4vw,40px)] leading-[1.15] tracking-[-0.02em] [font-weight:750]">
              Your family is one message away.
            </h2>
            <p className="mb-7 text-[17px] text-[#AAB7D4]">
              Send money home in the time it takes to type a text.
            </p>
            <a
              className="inline-flex min-h-14 items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-7 py-4 text-[18px] font-bold text-[#04231A] shadow-[0_10px_26px_-10px_rgba(37,211,102,0.6)] transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)] max-[600px]:w-full"
              href={genericHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <WhatsAppIcon size={22} />
              <span>Send money on WhatsApp</span>
            </a>
          </div>
        </section>

        {/* ============ FOR PARTNERS (Stage 5d — dual-audience band) ============
            Tailwind-native (no .lp classes) so it survives the legacy-CSS
            retirement untouched. */}
        <section id="partners" className="border-t border-[#e6e8ec] bg-[#0e1430] px-6 py-16 text-white">
          <div className="mx-auto max-w-5xl">
            <p className="text-sm font-semibold uppercase tracking-wider text-[#8f9bff]">For partners</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold leading-tight">
              White-label remittance infrastructure — your brand, your rail, our orchestration.
            </h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="font-medium">Your brand in WhatsApp</div>
                <p className="mt-1 text-sm text-white/70">
                  Bring your own Meta number — the agent, OTPs, and delivery notifications speak
                  as you, end to end.
                </p>
              </div>
              <div>
                <div className="font-medium">You settle, we orchestrate</div>
                <p className="mt-1 text-sm text-white/70">
                  Signed settlement instructions to your rail; signed status callbacks back.
                  Funds never touch SmartRemit.
                </p>
              </div>
              <div>
                <div className="font-medium">KYC your way</div>
                <p className="mt-1 text-sm text-white/70">
                  Run verification yourself (delegated) or use our tiered KYC. Sanctions screening
                  always stays on — never delegable.
                </p>
              </div>
              <div>
                <div className="font-medium">A real REST API</div>
                <p className="mt-1 text-sm text-white/70">
                  Quotes, beneficiaries, idempotent transactions, webhooks — plus a hosted
                  reference rail to integrate against in minutes.
                </p>
              </div>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="/docs"
                className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#0e1430] hover:bg-white/90"
              >
                Read the integration docs
              </a>
              <a
                href={genericHref}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-white/30 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
              >
                Talk to us
              </a>
            </div>
            <p className="mt-8 max-w-3xl border-t border-white/15 pt-5 text-xs leading-relaxed text-white/60">
              Non-custodial by design: SmartRemit provides the technology platform — conversation,
              quoting, compliance screening, and orchestration. Partners are the licensed money
              transmitters and settle all funds on their own rails. SmartRemit never holds,
              receives, or disburses customer money.
            </p>
          </div>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-[rgba(37,211,102,0.55)] bg-[radial-gradient(140%_95%_at_50%_0%,rgba(37,211,102,0.16)_0%,rgba(37,211,102,0)_52%),linear-gradient(180deg,#21357A_0%,#18285C_100%)] pt-[52px] pb-7 shadow-[inset_0_1px_0_rgba(37,211,102,0.4)]">
        <div className="mx-auto grid w-full max-w-[1120px] grid-cols-4 gap-7 px-5 max-[600px]:grid-cols-2">
          <div>
            <span className="mb-3.5 block text-[13px] font-bold uppercase tracking-[0.06em] text-[#57E398]">Countries</span>
            <ul className="flex flex-col gap-[9px]">
              {COUNTRIES.map((c) => (
                <li key={c.short} className="text-[14px] text-[#C9D6F2]">{c.name}</li>
              ))}
            </ul>
          </div>
          <div>
            <span className="mb-3.5 block text-[13px] font-bold uppercase tracking-[0.06em] text-[#57E398]">Links</span>
            <ul className="flex flex-col gap-[9px]">
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href="#how">How it works</a>
              </li>
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href="#countries">Countries</a>
              </li>
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href="#faq">FAQ</a>
              </li>
            </ul>
          </div>
          <div>
            <span className="mb-3.5 block text-[13px] font-bold uppercase tracking-[0.06em] text-[#57E398]">Account</span>
            <ul className="flex flex-col gap-[9px]">
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href="/account/login">Log in</a>
              </li>
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href="/account/register">Create account</a>
              </li>
            </ul>
          </div>
          <div>
            <span className="mb-3.5 block text-[13px] font-bold uppercase tracking-[0.06em] text-[#57E398]">Contact</span>
            <ul className="flex flex-col gap-[9px]">
              <li className="text-[14px] text-[#C9D6F2]">
                <a className="hover:text-[#FFFFFF]" href={genericHref} target="_blank" rel="noopener noreferrer">
                  Chat us on WhatsApp: +1 555 629 8293
                </a>
              </li>
              {/* PLACEHOLDER: replace with a real support email address. */}
              <li className="text-[14px] text-[#C9D6F2]">Email: [PLACEHOLDER support email]</li>
            </ul>
          </div>
          <div>
            <span className="mb-3.5 block text-[13px] font-bold uppercase tracking-[0.06em] text-[#57E398]">Legal</span>
            {/* PLACEHOLDER: real licensing & regulatory disclosures go here. Do
                NOT add fabricated regulatory badges or licence numbers. */}
            <p className="text-[12.5px] leading-[1.6] text-[#BAC6E2]">
              SmartRemit is a demonstration money-transfer service.{' '}
              [PLACEHOLDER: licensing &amp; regulatory disclosures]. Exchange
              rates are indicative and locked at the time you confirm a transfer.
            </p>
          </div>
        </div>
        <div className="mx-auto mt-8 max-w-[1120px] border-t border-[rgba(255,255,255,0.10)] px-5 pt-[22px] text-[13px] text-[#AAB7D4]">
          <span className="text-[18px] text-[#25D366]" aria-hidden="true">
            ◈
          </span>{' '}
          SmartRemit · Send money home, right from WhatsApp.
        </div>
      </footer>

      {/* ============ MOBILE STICKY CTA (≤600px only, via CSS) ============ */}
      <a
        className="fixed inset-x-3 bottom-3 z-[60] hidden min-h-[52px] items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-[22px] pt-[13px] pb-[calc(13px+env(safe-area-inset-bottom))] text-[16px] font-bold text-[#04231A] shadow-[0_10px_26px_-10px_rgba(37,211,102,0.6)] transition-[background,transform,box-shadow] duration-[180ms] ease-[ease] hover:bg-[#128C7E] hover:text-[#F5F8FF] hover:[transform:translateY(-1px)] max-[600px]:flex"
        href={genericHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        <WhatsAppIcon size={20} />
        <span>Send money on WhatsApp</span>
      </a>
    </div>
  );
}
