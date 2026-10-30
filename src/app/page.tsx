import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Link from 'next/link';
import { getFxRates, FALLBACK_FX_RATE } from '@/lib/rate';
import { DEFAULT_CURRENCY_FOR_COUNTRY, type CurrencyCode } from '@/lib/types';
import { calcDestinations } from './landing/calc-destinations';
import { waLink, WA_MESSAGES, corridorMessage, WA_PHONE, formatWaPhone } from './landing/wa';
import WhatsAppIcon from './landing/WhatsAppIcon';
import BrandLogo from './landing/BrandLogo';
import SocialLinks from './landing/SocialLinks';
import { SHARE_IMAGE } from './landing/share-image';
import { SMARTREMIT_ICONS } from './brand-icons';
import { SkipLink } from '@/components/skip-link';
import { BankIcon, BadgeIcon, ShieldIcon, AuditIcon, BoltIcon, GlobeIcon } from './landing/TrustIcons';
import RateCalculator from './landing/RateCalculator';
import { getFeaturedSendPartner } from '@/lib/featured-send-partner';
import HeroPipeline from './landing/HeroPipeline';
import { ChatMock, OpsMock, RailMock, AiMock } from './landing/showcase';
import { submitPartnerRequestAction } from './partners-action';
import WaitlistForm from './landing/WaitlistForm';
import { CHAT_CHANNELS, AI_APPS_GUIDE_HREF, TELEGRAM_BOT_HREF, type ChannelStatus } from './landing/channels';
import { PARTNER_CORRIDORS, WAITLIST_DESTINATIONS } from './landing/corridors';
import { PARTNER_TYPES } from '@/lib/partner-type';
import { companyFooterLine } from '@/lib/company';

// Self-hosted Inter, scoped to the landing tree only (applied on the landing
// root div), so it never touches the sh-* dashboard or .payapp themes.
const inter = Inter({ subsets: ['latin'], display: 'swap' });

const TITLE = 'SmartRemit.ai — Send money home from the chat apps you already use.';
// Raj's website brief (Oct 25, owner go): US to India is the launch corridor and every other
// supported country is "coming next". The count follows ./landing/corridors (one list), never a
// literal: every waitlist country except the US (send-from) and India (launch).
const COMING_NEXT_COUNT = WAITLIST_DESTINATIONS.filter((d) => d.value !== 'US' && d.value !== 'IN').length;
const DESCRIPTION =
  `Send money home by chatting with the SmartRemit AI on WhatsApp. It quotes the rate for your transfer, a hosted page takes payment, and a licensed partner settles. SmartRemit never holds your money. Launching with US to India, with ${COMING_NEXT_COUNT} more countries coming next. Sanctions screening runs on every transfer (demo: reference list; production feed per partner).`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description:
      'Send money home by chatting on WhatsApp. Licensed partners settle, and SmartRemit never holds your money. Launching with US to India.',
    type: 'website',
    siteName: 'SmartRemit.ai',
    images: [SHARE_IMAGE],
  },
  twitter: { card: 'summary_large_image', title: TITLE, images: [SHARE_IMAGE] },
  icons: SMARTREMIT_ICONS,
};

// ISR revalidates hourly. getFxRates() caches 5 min with a 60-min ceiling, and
// the ECB publishes one fixing per business day, so the figure below is always
// printed WITH its fixing date (ui-08).
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
  { name: 'Hong Kong', short: 'Hong Kong', code: 'hk' },
  { name: 'Mexico', short: 'Mexico', code: 'mx' },
  { name: 'Germany', short: 'Germany', code: 'de' },
  { name: 'France', short: 'France', code: 'fr' },
  { name: 'Netherlands', short: 'Netherlands', code: 'nl' },
  { name: 'Ireland', short: 'Ireland', code: 'ie' },
  { name: 'Italy', short: 'Italy', code: 'it' },
  { name: 'Spain', short: 'Spain', code: 'es' },
  { name: 'Austria', short: 'Austria', code: 'at' },
  { name: 'Belgium', short: 'Belgium', code: 'be' },
];

// The corridor section (Raj's brief, Oct 25): US to India first, the rest "coming next".
const LAUNCH_COUNTRIES = COUNTRIES.filter((c) => c.code === 'us' || c.code === 'in');
const COMING_NEXT_COUNTRIES = COUNTRIES.filter((c) => c.code !== 'us' && c.code !== 'in');
const CHIP =
  'inline-flex items-center gap-2.5 rounded-full border border-[#dbe4f0] bg-white py-2 pr-4 pl-2.5 transition-[border-color,background-color,transform] duration-150';

function Flag({ code }: { code: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="block h-auto w-7 rounded-[4px] bg-[#eef4fc]"
      src={`/flags/${code}.svg`}
      alt=""
      width={28}
      height={21}
      loading="lazy"
    />
  );
}

// Corridor checkbox options for the "Partner with us" form (and the waitlist's
// destination list) live in ./landing/corridors — one list, shared with the
// server actions' allow-lists.

// Scroll-reveal recipe (existing lp-rise keyframe; progressive — only engages
// where animation-timeline is supported, and only under motion-safe). The
// view() timeline needs the DOCUMENT as its scroller, so the root uses
// overflow-x-clip: overflow-x-hidden made the root div a (non-scrolling) scroll
// container, freezing every reveal at its layout position (the partner form sat
// at ~54% opacity). The range ends at entry 75%, so a section is fully shown
// once 3/4 of it (or, if taller than the screen, its top 1/4 of the way down)
// is on screen, including when you land on it via #partner-with-us.
const RISE =
  'motion-safe:supports-[animation-timeline:view()]:[animation-fill-mode:both] motion-safe:supports-[animation-timeline:view()]:[animation-name:lp-rise] motion-safe:supports-[animation-timeline:view()]:[animation-range:entry_0%_entry_75%] motion-safe:supports-[animation-timeline:view()]:[animation-timeline:view()] motion-safe:supports-[animation-timeline:view()]:[animation-timing-function:linear]';

// Button recipes.
const BTN_WA =
  'inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-full bg-[#25d366] px-7 text-[16px] font-bold text-[#04231a] shadow-[0_10px_30px_-10px_rgba(37,211,102,0.65)] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]';
const BTN_GHOST =
  'inline-flex min-h-[52px] items-center justify-center gap-2 rounded-full border border-[#c5d3e6] bg-white/70 px-7 text-[16px] font-semibold text-[#0b1b3f] transition-[border-color,background-color] duration-150 hover:border-[#0c5bd2]/50 hover:bg-white';
// The brand's own action (not a WhatsApp hand-off): deep blue, white label (6.1:1).
const BTN_PRIMARY =
  'inline-flex min-h-[50px] items-center justify-center rounded-full bg-[#0c5bd2] px-7 text-[15px] font-bold text-white shadow-[0_10px_26px_-12px_rgba(12,91,210,0.7)] transition-[background-color,transform] duration-150 hover:bg-[#0a4fb8] hover:[transform:translateY(-1px)]';

// Repeated type recipes (showcase rows + footer columns).
const EYEBROW = 'mb-3 text-[14px] font-semibold tracking-[-0.005em]';
const SHOWCASE_H3 = 'text-[clamp(24px,3.2vw,38px)] font-semibold leading-[1.12] tracking-[-0.02em]';
const SHOWCASE_COPY = 'mt-4 max-w-[46ch] text-[16px] leading-relaxed text-[#475569]';
const FOOT_HEAD = 'mb-4 block text-[12px] font-bold uppercase tracking-[0.1em] text-[#475569]';
const FOOT_LIST = 'flex flex-col gap-2.5 text-[14px] text-[#475569]';

// Telegram hand-off: a deep Telegram blue so the white label keeps AA contrast (5.6:1).
const BTN_TG =
  'inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-full bg-[#0f6aa3] px-7 text-[16px] font-bold text-white shadow-[0_10px_30px_-12px_rgba(15,106,163,0.6)] transition-[background-color,transform] duration-150 hover:bg-[#0c5a8c] hover:[transform:translateY(-1px)]';

function TelegramIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.94 4.66 18.9 19.02c-.23 1.01-.83 1.26-1.68.79l-4.63-3.41-2.23 2.15c-.25.25-.45.45-.93.45l.33-4.71 8.58-7.75c.37-.33-.08-.52-.58-.19L7.16 13.03l-4.57-1.43c-.99-.31-1.01-.99.21-1.47l17.86-6.88c.83-.31 1.55.19 1.28 1.41Z" />
    </svg>
  );
}

// "Choose your chat app" badge colours: green only for what is open to everyone.
const CHANNEL_BADGE: Record<ChannelStatus, string> = {
  available: 'border-[#047857]/40 bg-[#ecfdf5] text-[#065f46]',
  'coming-soon': 'border-[#c5d3e6] bg-[#f5f9ff] text-[#334155]',
  'early-access': 'border-[#0c5bd2]/35 bg-[#eef4fc] text-[#0a4fb8]',
};

function fmtRate(rate: number): string {
  return '₹' + rate.toFixed(2);
}

function LoginMenu() {
  const item =
    'flex flex-col gap-0.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-[#eef4fc]';
  return (
    <div className="group relative max-[760px]:hidden">
      <a
        className="inline-flex min-h-11 items-center gap-1.5 text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f]"
        href="https://send.smartremit.ai/portal/login"
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
        <div className="w-64 rounded-2xl border border-[#dbe4f0] bg-white p-1.5 shadow-[0_24px_60px_-24px_rgba(11,27,63,0.28)]">
          <a className={item} href="https://send.smartremit.ai/portal/login">
            <span className="text-[14px] font-semibold text-[#0b1b3f]">Customers</span>
            <span className="text-[12px] text-[#475569]">Track transfers &amp; receipts</span>
          </a>
          <a className={item} href="/login">
            <span className="text-[14px] font-semibold text-[#0b1b3f]">Employee portal</span>
            <span className="text-[12px] text-[#475569]">Staff &amp; partner dashboards</span>
          </a>
          <a className={item} href="/partner">
            <span className="text-[14px] font-semibold text-[#0b1b3f]">Partners</span>
            <span className="text-[12px] text-[#475569]">Partner dashboard &amp; API keys</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export default async function LandingPage({
  searchParams,
}: {
  // Next.js 16: searchParams is a Promise. We read ?partner=ok|err|rate and
  // ?waitlist=ok|err|rate to show the post-submit notes next to the two forms,
  // and utm_source / utm_campaign to attribute waitlist signups.
  searchParams?: Promise<{
    partner?: string;
    waitlist?: string;
    utm_source?: string;
    utm_campaign?: string;
  }>;
}) {
  // ui-08 (Task 9): the figure is shown ONLY with its provenance — live ⇒
  // "daily reference rate, ECB fixing of <date>"; a cached rate ⇒ "indicative";
  // refused (getFxRates throws RateUnavailableError) ⇒ no figure at all, never
  // a constant labelled live. Any throw degrades — the page never errors on FX.
  // Home-Send H1: the featured send partner, resolved on the server in parallel with
  // FX and memoised per instance at the FX soft-TTL cadence (this route renders per
  // request: it awaits searchParams). Never throws; unset env ⇒ null with no db work
  // ⇒ the calculator is unchanged. Amount/destination are read client-side.
  const featuredPromise = getFeaturedSendPartner();
  // The calculator's "to" picker: one leg per other destination currency, in parallel with the
  // USD leg. A refused leg only hides that country's figure (calc-destinations.ts).
  const otherCurrencies = [...new Set(Object.values(DEFAULT_CURRENCY_FOR_COUNTRY))].filter(
    (c): c is CurrencyCode => c !== 'USD' && c !== 'INR',
  );
  const legsPromise = Promise.allSettled(otherCurrencies.map((c) => getFxRates(c)));
  let fxRate: number | null = null;
  let fxLive = false;
  let fxAsOf: string | null = null;
  try {
    const fx = await getFxRates('USD');
    fxRate = fx.toInr;
    fxLive = fx.source === 'live';
    fxAsOf = fx.asOf ?? null;
  } catch {
    /* no figure */
  }
  // The decorative hero + chat mock always draw A figure: the live mid when we
  // have it, else the display table's illustrative one — and only a live figure
  // is ever labelled live (HeroPipeline's `live`; ChatMock never claims it).
  const illustrativeRate = fxRate ?? FALLBACK_FX_RATE;
  const featuredSendPartner = await featuredPromise;
  const legs = await legsPromise;
  const legToUsd = new Map<CurrencyCode, number>();
  legs.forEach((r, i) => {
    if (r.status === 'fulfilled') legToUsd.set(otherCurrencies[i], r.value.toUsd);
  });
  const destinations = calcDestinations(fxRate, (c) => legToUsd.get(c) ?? null);

  const params = await searchParams;
  const partnerStatus = params?.partner;
  const waitlistStatus = params?.waitlist;

  const genericHref = waLink(WA_MESSAGES.generic);

  return (
    // The [--lp-*] custom properties feed RateCalculator's legacy var hooks.
    <div
      className={`${inter.className} min-h-svh overflow-x-clip bg-[#f5f9ff] leading-[1.6] text-[#0b1b3f] antialiased max-[600px]:pb-[84px] [--lp-bg-800:#eef4fc] [--lp-bg-900:#ffffff] [--lp-border:#8391a8] [--lp-text-100:#0b1b3f] [--lp-text-300:#475569] [--lp-wa-deep:#1fbd5d] [--lp-green-text:#047857] [--lp-wa:#25d366] [&_:focus-visible]:rounded-[6px] [&_:focus-visible]:[outline-offset:3px] [&_:focus-visible]:[outline:2px_solid_#0c5bd2]`}
    >
      <SkipLink />
      {/* ============ NAV ============ */}
      <nav
        className="sticky top-0 z-50 border-b border-[#dbe4f0] bg-[rgba(245,249,255,0.85)] backdrop-blur-[12px]"
        aria-label="Primary"
      >
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-5 px-5 py-3 max-[520px]:gap-3">
          <a className="inline-flex shrink-0 items-center" href="#top">
            <BrandLogo height={40} eager className="h-7 min-[380px]:h-8 min-[400px]:h-9 sm:h-10" />
          </a>
          {/* Collapses right to left as the bar narrows: section links, then
              Create account, then the Log in menu (a plain link on phones),
              then the WhatsApp label (icon only; the sticky CTA carries it).
              Docs never collapses, so the gaps and the phone logo are a little
              tighter than before to keep every label on one line. */}
          <div className="ml-auto flex items-center gap-3 max-[520px]:gap-2">
            <a
              className="text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f] max-[1180px]:hidden"
              href="#inside"
            >
              What&rsquo;s inside
            </a>
            {/* Raj's brief: the rate at the top right. The chip opens the calculator; with no
                figure (FX refused) it is the plain Calculator link it replaced. */}
            <a
              className="whitespace-nowrap text-[14px] font-semibold text-[#047857] tabular-nums transition-colors hover:text-[#0b1b3f] max-[1180px]:hidden"
              href="#calculator"
              aria-label={fxRate === null ? 'Calculator' : `Calculator: 1 USD = ${fmtRate(fxRate)}, daily reference rate`}
            >
              {fxRate === null ? 'Calculator' : `$1 = ${fmtRate(fxRate)}`}
            </a>
            <a
              className="text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f] max-[760px]:hidden"
              href="#waitlist"
            >
              Join waitlist
            </a>
            <a
              className="text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f] max-[760px]:hidden"
              href="#partner-with-us"
            >
              Partner with us
            </a>
            <a
              className="text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f] max-[760px]:hidden"
              href="/about"
            >
              About
            </a>
            <Link
              className="inline-flex min-h-11 items-center text-[14px] text-[#475569] transition-colors hover:text-[#0b1b3f]"
              href="/docs"
            >
              Docs
            </Link>
            <LoginMenu />
            <a
              className="inline-flex min-h-11 items-center text-[14px] font-medium text-[#475569] transition-colors hover:text-[#0b1b3f] min-[761px]:hidden"
              href="https://send.smartremit.ai/portal/login"
            >
              Log in
            </a>
            <a
              className="inline-flex min-h-10 items-center rounded-full border border-[#c5d3e6] px-4 text-[13.5px] font-semibold text-[#0b1b3f] transition-[border-color,background-color] duration-150 hover:border-[#0c5bd2]/50 hover:bg-white max-[1023px]:hidden"
              href="https://send.smartremit.ai/portal/login"
            >
              Create account
            </a>
            <a
              className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[#25d366] px-4 text-[13.5px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)] max-[520px]:min-h-11 max-[520px]:min-w-11 max-[520px]:justify-center max-[520px]:px-0"
              href={genericHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Start on WhatsApp"
            >
              <WhatsAppIcon size={16} />
              <span className="max-[520px]:sr-only">Start on WhatsApp</span>
            </a>
          </div>
        </div>
      </nav>

      <main id="top">
        {/* ============ HERO — customer first: the promise + the live chat ============ */}
        {/* id="main" is the skip link's target; <main id="top"> stays for the logo's #top. */}
        <section
          id="main"
          className="relative scroll-mt-20 overflow-hidden px-5 pt-[clamp(40px,6vw,88px)] pb-[clamp(56px,7vw,104px)]"
          aria-labelledby="hero-h"
        >
          {/* Backdrop (decorative): soft sky/green light and a dotted "globe"
              field behind the calculator, echoing the launch poster. */}
          <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
            <div className="absolute -top-[25%] -right-[15%] h-[85%] w-[70%] bg-[radial-gradient(closest-side,rgba(72,179,245,0.24),transparent)]" />
            <div className="absolute -bottom-[30%] -left-[15%] h-[70%] w-[60%] bg-[radial-gradient(closest-side,rgba(52,211,153,0.16),transparent)]" />
            <div className="absolute inset-y-0 right-0 w-full bg-[radial-gradient(circle,rgba(12,91,210,0.20)_1.1px,transparent_1.6px)] [background-size:13px_13px] [mask-image:radial-gradient(ellipse_48%_52%_at_76%_42%,#000_20%,transparent_75%)] lg:w-[62%] lg:[mask-image:radial-gradient(ellipse_60%_55%_at_55%_45%,#000_25%,transparent_78%)]" />
          </div>

          <div className="relative z-[1] mx-auto grid w-full max-w-[1180px] items-center gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-10">
            <div>
              <h1
                id="hero-h"
                className="text-[clamp(36px,5vw,60px)] font-extrabold leading-[1.05] tracking-[-0.035em] text-[#0b1b3f]"
              >
                Send money home{' '}
                {/* AA-large on #f5f9ff at every stop: #0e7490 5.1, #0d9488 3.5, #059669 3.6. */}
                <span className="inline-block bg-[linear-gradient(95deg,#0e7490,#0d9488_45%,#059669)] bg-clip-text pb-[0.08em] text-transparent">
                  from the chat apps you already use.
                </span>
              </h1>
              <span
                className="mt-5 block h-[5px] w-16 rounded-full bg-[linear-gradient(90deg,#0c5bd2,#48b3f5,#34d399)]"
                aria-hidden="true"
              />
              <p className="mt-6 text-[clamp(20px,2.3vw,26px)] font-medium tracking-[-0.01em] text-[#0b1b3f]">
                Start on <strong className="font-bold">WhatsApp</strong> or{' '}
                <strong className="font-bold">Telegram.</strong> AI assistants such as Claude, ChatGPT
                and Perplexity are in early access.
              </p>
              <p className="mt-3 max-w-[52ch] text-[16.5px] leading-relaxed text-[#475569]">
                The SmartRemit AI quotes the rate for your transfer in the chat, a hosted page takes
                payment, and a licensed partner settles — every step signed and audited. SmartRemit
                never holds your money. Sanctions screening runs on every transfer (demo: reference
                list; production feed per partner).
              </p>

              <ul className="mt-8 grid max-w-[560px] gap-3 sm:grid-cols-3">
                {[
                  { icon: <BoltIcon />, label: 'Familiar and easy' },
                  { icon: <ShieldIcon />, label: 'Safe and secure' },
                  { icon: <GlobeIcon />, label: 'Built for a borderless world' },
                ].map((b) => (
                  <li key={b.label} className="flex items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#e3f6ee] text-[#047857] ring-1 ring-[#bfe8d3]">
                      {b.icon}
                    </span>
                    <span className="text-[14.5px] font-semibold leading-snug text-[#0b1b3f]">
                      {b.label}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-9 flex flex-wrap items-center gap-3.5">
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

            {/* Live FX calculator (owner, Oct 30): top right of the hero; the phone picture moved to #chat-demo. */}
            <div id="calculator" className="relative scroll-mt-24">
              <p className={`${EYEBROW} text-[#047857]`}>Live FX</p>
              <RateCalculator
                rate={fxRate}
                live={fxLive}
                asOf={fxAsOf}
                featured={featuredSendPartner}
                destinations={destinations}
              />
              {/* With no rate, the calculator itself explains that the rate is quoted in chat. */}
              {fxRate === null ? null : (
                <p className="mt-3 text-[14px] leading-relaxed text-[#475569]">
                  1 USD = {fmtRate(fxRate)}, {fxLive ? 'daily reference rate' : 'indicative rate'}
                  {fxAsOf ? ` (ECB fixing of ${fxAsOf})` : ''}. You see the exact rate and total before
                  you pay.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ============ TRUST BAND ============ */}
        <section
          aria-label="Why you can trust SmartRemit"
          className="border-y border-[#dbe4f0] bg-white"
        >
          <div className="mx-auto flex w-full max-w-[1180px] flex-col items-center gap-3.5 px-5 py-6">
            <p className="text-center text-[14px] font-semibold text-[#0b1b3f]">
              Non-custodial remittance infrastructure
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-[13.5px] text-[#475569]">
              <li className="inline-flex items-center gap-2.5">
                <BankIcon /> Non-custodial by design
              </li>
              <li className="inline-flex items-center gap-2.5">
                <BadgeIcon /> Licensed-partner settled
              </li>
              <li className="inline-flex items-center gap-2.5">
                <ShieldIcon /> Sanctions screening runs on every transfer (demo: reference list)
              </li>
              <li className="inline-flex items-center gap-2.5">
                <AuditIcon /> Full audit trail
              </li>
            </ul>
          </div>
        </section>

        {/* ============ CHOOSE YOUR CHAT APP — Raj's follow-up, Oct 25 ============ */}
        <section
          id="channels"
          className={`scroll-mt-20 px-5 pt-[clamp(56px,8vw,110px)] ${RISE}`}
          aria-labelledby="channels-h"
        >
          <div className="mx-auto w-full max-w-[1180px]">
            <div className="mx-auto max-w-[680px] text-center">
              <h2
                id="channels-h"
                className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
              >
                Choose your chat app
              </h2>
              <p className="mt-4 text-[16px] text-[#475569]">
                One SmartRemit AI, in the apps you already use. The rate, the checks and the secure
                pay page are the same everywhere.
              </p>
            </div>
            <ul className="mt-10 grid gap-5 md:grid-cols-3">
              {CHAT_CHANNELS.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-col rounded-[20px] border border-[#dbe4f0] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(11,27,63,0.35)]"
                >
                  <span
                    className={`self-start rounded-full border px-3 py-1 text-[12.5px] font-semibold ${CHANNEL_BADGE[c.status]}`}
                  >
                    {c.badge}
                  </span>
                  <h3 className="mt-4 text-[20px] font-semibold leading-[1.25] tracking-[-0.01em]">{c.title}</h3>
                  <p className="mt-2 flex-1 text-[15px] leading-relaxed text-[#475569]">{c.body}</p>
                  {c.id === 'whatsapp' ? (
                    <a
                      className={`${BTN_WA} mt-5 self-start`}
                      href={genericHref}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <WhatsAppIcon size={18} />
                      <span>Start on WhatsApp</span>
                    </a>
                  ) : c.id === 'telegram' ? (
                    <a
                      className={`${BTN_TG} mt-5 self-start`}
                      href={TELEGRAM_BOT_HREF}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <TelegramIcon />
                      <span>Start on Telegram</span>
                    </a>
                  ) : c.id === 'ai-apps' ? (
                    <Link
                      className="mt-5 inline-flex min-h-11 items-center self-start text-[15px] font-semibold text-[#0c5bd2] hover:underline"
                      href={AI_APPS_GUIDE_HREF}
                    >
                      How AI apps connect &rarr;
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-center text-[12.5px] text-[#475569]">
              Claude, ChatGPT and Perplexity are trademarks of their owners. SmartRemit is not
              affiliated with or endorsed by them.
            </p>
          </div>
        </section>

        {/* ============ WHAT'S INSIDE — product showcase ============ */}
        <section id="inside" className="scroll-mt-20 px-5 py-[clamp(64px,9vw,140px)]" aria-labelledby="inside-h">
          <div className="mx-auto w-full max-w-[1180px]">
            <div className={`mx-auto max-w-[680px] text-center ${RISE}`}>
              <h2
                id="inside-h"
                className="text-[clamp(30px,4.5vw,52px)] font-semibold leading-[1.08] tracking-[-0.025em]"
              >
                What&rsquo;s inside.
              </h2>
              <p className="mt-4 text-[17px] text-[#475569]">
                The same system, surface by surface.
              </p>
            </div>

            <div className="mt-[clamp(48px,6vw,88px)] flex flex-col gap-[clamp(64px,8vw,120px)]">
              {/* (a) The conversation — the whole transfer, stage by stage (the
                  chat itself is the #chat-demo phone). */}
              <div className={`flex flex-col gap-10 lg:gap-14 ${RISE}`}>
                <div className="max-w-[720px]">
                  <p className={`${EYEBROW} text-[#047857]`}>The conversation</p>
                  <h3 className={SHOWCASE_H3}>
                    An agent that speaks money.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Quote, KYC, approval, receipt — the entire transfer is a conversation. The
                    agent locks the rate for your transfer and holds it while you pay. It never holds
                    your funds.
                  </p>
                </div>
                <HeroPipeline rate={illustrativeRate} live={fxLive} />
              </div>

              {/* (b) The ops dashboard */}
              <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-20 ${RISE}`}>
                <div className="lg:order-2">
                  <p className={`${EYEBROW} text-[#0e7490]`}>The ops dashboard</p>
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
                  <p className={`${EYEBROW} text-[#047857]`}>The partner rail</p>
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
                  <p className={`${EYEBROW} text-[#0e7490]`}>The AI layer</p>
                  <h3 className={SHOWCASE_H3}>
                    One AI layer, two sides.
                  </h3>
                  <p className={SHOWCASE_COPY}>
                    Customers get an agent that answers in plain language. The platform runs
                    compliance on every transfer — sanctions screening is structurally
                    impossible to switch off, in every KYC mode (demo: reference list;
                    production feed per partner).
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
          className={`scroll-mt-20 border-t border-[#dbe4f0] px-5 py-[clamp(56px,8vw,110px)] ${RISE}`}
          aria-labelledby="corridors-h"
        >
          <div className="mx-auto w-full max-w-[1180px] text-center">
            <h2
              id="corridors-h"
              className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
            >
              Launching with US to India.
            </h2>
            <p className="mt-4 text-[16px] text-[#475569]">
              We start where families send the most. Tap India to start the chat.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              {LAUNCH_COUNTRIES.map((c, i) => (
                <span key={c.short} className="inline-flex items-center gap-3">
                  {i > 0 ? (
                    <span className="text-[20px] text-[#475569]" aria-hidden="true">
                      &rarr;
                    </span>
                  ) : null}
                  {c.code === 'in' ? (
                    <a
                      className={`${CHIP} border-[#0c5bd2]/50 hover:border-[#0c5bd2] hover:bg-[#eef4fc] hover:[transform:translateY(-2px)]`}
                      href={waLink(corridorMessage(c.name))}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Flag code={c.code} />
                      <span className="text-[14px] font-semibold text-[#0b1b3f]">{c.short}</span>
                    </a>
                  ) : (
                    <span className={CHIP}>
                      <Flag code={c.code} />
                      <span className="text-[14px] font-semibold text-[#0b1b3f]">{c.short}</span>
                    </span>
                  )}
                </span>
              ))}
            </div>

            <h3 className="mt-14 text-[20px] font-semibold tracking-[-0.01em]">Coming next</h3>
            <p className="mt-2 text-[15px] text-[#475569]">
              {COMING_NEXT_COUNT} more countries, to send from or to. Tap one to join the waitlist.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {COMING_NEXT_COUNTRIES.map((c) => (
                <a
                  key={c.short}
                  className={`${CHIP} hover:border-[#0c5bd2]/40 hover:bg-[#eef4fc] hover:[transform:translateY(-2px)]`}
                  href="#waitlist"
                >
                  <Flag code={c.code} />
                  <span className="text-[14px] font-semibold text-[#0b1b3f]">{c.short}</span>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* ============ LIVE FX CALCULATOR ============ */}
        <section
          id="chat-demo"
          className={`scroll-mt-20 border-t border-[#dbe4f0] px-5 py-[clamp(64px,9vw,130px)] ${RISE}`}
          aria-labelledby="chat-demo-h"
        >
          <div className="mx-auto grid w-full max-w-[1080px] items-center gap-10 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className={`${EYEBROW} text-[#047857]`}>In the chat</p>
              <h2
                id="chat-demo-h"
                className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
              >
                Quote, check and pay in one chat.
              </h2>
              <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#0b1b3f]">
                The SmartRemit AI quotes your rate, checks the details with you and sends a secure
                link to pay. You see the exact rate and total before you pay.
              </p>
              <p className="mt-2 max-w-[46ch] text-[15px] leading-relaxed text-[#475569]">
                Your first transfer has no SmartRemit fee, then a flat $1.99 per bank transfer.
              </p>
            </div>
            <div className="relative">
              {/* Dashed routes + pins around the phone (decorative, desktop only). */}
              <svg
                className="pointer-events-none absolute top-1/2 left-1/2 hidden h-[640px] w-[500px] -translate-x-1/2 -translate-y-1/2 lg:block"
                viewBox="0 0 500 640"
                fill="none"
                aria-hidden="true"
              >
                <path d="M40 150 C 120 40, 330 20, 450 110" stroke="#11a1c6" strokeWidth="2" strokeDasharray="6 8" strokeLinecap="round" opacity="0.7" />
                <path d="M470 380 C 500 470, 430 560, 330 600" stroke="#34d399" strokeWidth="2" strokeDasharray="6 8" strokeLinecap="round" opacity="0.8" />
                <g fill="#0c5bd2">
                  <circle cx="40" cy="150" r="7" />
                  <circle cx="450" cy="110" r="7" />
                </g>
                <circle cx="40" cy="150" r="14" fill="#0c5bd2" opacity="0.14" />
                <circle cx="450" cy="110" r="14" fill="#0c5bd2" opacity="0.14" />
                <circle cx="470" cy="380" r="6" fill="#047857" />
                <circle cx="470" cy="380" r="13" fill="#34d399" opacity="0.22" />
              </svg>
              <ChatMock rate={illustrativeRate} />
            </div>
          </div>
        </section>

        {/* ============ FINAL CTA ============ */}
        <section
          className={`relative overflow-hidden border-t border-[#dbe4f0] px-5 py-[clamp(72px,10vw,150px)] text-center ${RISE}`}
          aria-labelledby="final-h"
        >
          <div
            className="pointer-events-none absolute -inset-[30%] z-0 bg-[radial-gradient(40%_40%_at_35%_45%,rgba(72,179,245,0.18),transparent_70%),radial-gradient(45%_45%_at_70%_55%,rgba(52,211,153,0.14),transparent_70%)] blur-[12px] motion-safe:[animation-direction:alternate] motion-safe:[animation-duration:28s] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-name:lp-aurora] motion-safe:[animation-timing-function:ease-in-out]"
            aria-hidden="true"
          />
          <div className="relative z-[1] mx-auto w-full max-w-[760px]">
            <h2
              id="final-h"
              className="text-balance text-[clamp(30px,4.5vw,54px)] font-semibold leading-[1.08] tracking-[-0.025em]"
            >
              Your family is one message away.
            </h2>
            <p className="mt-5 text-[17px] text-[#475569]">
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
            <p className="mt-8 text-[14px] text-[#475569]">
              Building a remittance product?{' '}
              <Link className="font-semibold text-[#0c5bd2] hover:underline" href="/docs">
                Read the partner docs →
              </Link>
            </p>
          </div>
        </section>

        {/* ============ JOIN WAITLIST — public early-access form ============ */}
        <WaitlistForm
          status={waitlistStatus}
          utmSource={params?.utm_source}
          utmCampaign={params?.utm_campaign}
        />

        {/* ============ PARTNER WITH US — public lead form ============ */}
        <section
          id="partner-with-us"
          className={`scroll-mt-20 border-t border-[#dbe4f0] px-5 py-[clamp(64px,9vw,130px)] ${RISE}`}
          aria-labelledby="partner-h"
        >
          <div className="mx-auto grid w-full max-w-[1080px] items-start gap-10 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className={`${EYEBROW} text-[#0e7490]`}>For partners</p>
              <h2
                id="partner-h"
                className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
              >
                Partner with us.
              </h2>
              <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#475569]">
                Licensed money transmitters: reach customers through the SmartRemit WhatsApp
                assistant and pay page, with signed settlement webhooks, a REST API, and a
                self-service dashboard. You keep
                the licence and the funds — we orchestrate the rest. Tell us your corridors and
                we&rsquo;ll be in touch.
              </p>
            </div>

            <form
              action={submitPartnerRequestAction}
              className="rounded-2xl border border-[#dbe4f0] bg-white p-6 sm:p-8"
            >
              {/* Post-submit notes — driven by ?partner=ok|err|rate. */}
              {partnerStatus === 'ok' && (
                <p
                  role="status"
                  className="mb-6 rounded-xl border border-[#a7e3c6] bg-[#e8f7ef] px-4 py-3 text-[14px] text-[#065f46]"
                >
                  Thanks — we&rsquo;ll be in touch.
                </p>
              )}
              {partnerStatus === 'err' && (
                <p
                  role="alert"
                  className="mb-6 rounded-xl border border-[#f5c2c2] bg-[#fdecec] px-4 py-3 text-[14px] text-[#991b1b]"
                >
                  Please check the form — a company name, valid email, phone, partner type, and
                  at least one corridor are required.
                </p>
              )}
              {partnerStatus === 'rate' && (
                <p
                  role="alert"
                  className="mb-6 rounded-xl border border-[#f5c2c2] bg-[#fdecec] px-4 py-3 text-[14px] text-[#991b1b]"
                >
                  Too many requests — please try again later.
                </p>
              )}

              {/* Honeypot — visually hidden, off-screen, not announced. Bots fill
                  it; humans don't. A non-empty value is silently dropped. */}
              <div
                aria-hidden="true"
                className="absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden"
              >
                <label htmlFor="website">Leave this field empty</label>
                <input
                  id="website"
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="company_name"
                    className="text-[13px] font-semibold text-[#0b1b3f]"
                  >
                    Company name
                  </label>
                  <input
                    id="company_name"
                    type="text"
                    name="company_name"
                    required
                    minLength={2}
                    maxLength={200}
                    autoComplete="organization"
                    className="min-h-[46px] rounded-xl border border-[#8391a8] bg-white px-4 text-[15px] text-[#0b1b3f] placeholder:text-[#667085]"
                    placeholder="Acme Remit Inc."
                  />
                </div>

                <div className="flex flex-col gap-5 sm:flex-row sm:gap-4">
                  <div className="flex flex-1 flex-col gap-2">
                    <label
                      htmlFor="email"
                      className="text-[13px] font-semibold text-[#0b1b3f]"
                    >
                      Work email
                    </label>
                    <input
                      id="email"
                      type="email"
                      name="email"
                      required
                      maxLength={320}
                      autoComplete="email"
                      className="min-h-[46px] rounded-xl border border-[#8391a8] bg-white px-4 text-[15px] text-[#0b1b3f] placeholder:text-[#667085]"
                      placeholder="you@company.com"
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-2">
                    <label
                      htmlFor="phone"
                      className="text-[13px] font-semibold text-[#0b1b3f]"
                    >
                      Phone
                    </label>
                    <input
                      id="phone"
                      type="tel"
                      name="phone"
                      required
                      maxLength={40}
                      autoComplete="tel"
                      className="min-h-[46px] rounded-xl border border-[#8391a8] bg-white px-4 text-[15px] text-[#0b1b3f] placeholder:text-[#667085]"
                      placeholder="+1 555 123 4567"
                    />
                  </div>
                </div>

                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-1 text-[13px] font-semibold text-[#0b1b3f]">
                    I am a:
                  </legend>
                  <div className="flex flex-col gap-2.5">
                    {PARTNER_TYPES.map((t) => (
                      <label
                        key={t.value}
                        className="inline-flex items-center gap-2.5 text-[14px] text-[#475569]"
                      >
                        <input
                          type="radio"
                          name="partner_type"
                          value={t.value}
                          required
                          className="h-4 w-4 accent-[#0c5bd2]"
                        />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-1 text-[13px] font-semibold text-[#0b1b3f]">
                    Corridors of interest
                  </legend>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                    {PARTNER_CORRIDORS.map((c) => (
                      <label
                        key={c.value}
                        className="inline-flex items-center gap-2.5 text-[14px] text-[#475569]"
                      >
                        <input
                          type="checkbox"
                          name="corridors"
                          value={c.value}
                          className="h-4 w-4 accent-[#0c5bd2]"
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="comments"
                    className="text-[13px] font-semibold text-[#0b1b3f]"
                  >
                    Anything else?{' '}
                    <span className="font-normal text-[#52607a]">(optional)</span>
                  </label>
                  <textarea
                    id="comments"
                    name="comments"
                    rows={4}
                    maxLength={2000}
                    className="resize-y rounded-xl border border-[#8391a8] bg-white px-4 py-3 text-[15px] text-[#0b1b3f] placeholder:text-[#667085]"
                    placeholder="Volumes, target corridors, timeline…"
                  />
                </div>

                <button
                  type="submit"
                  className={`mt-1 ${BTN_PRIMARY}`}
                >
                  Submit request
                </button>
              </div>
            </form>
          </div>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-[#dbe4f0] bg-white pt-[clamp(40px,6vw,64px)] pb-8">
        <div className="mx-auto mb-10 flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-6 px-5">
          <div className="flex flex-col items-start gap-3">
            <BrandLogo height={40} />
            <p className="text-[14px] text-[#475569]">Global money transfers, made simpler.</p>
          </div>
          <nav aria-label="SmartRemit on social media">
            <SocialLinks />
          </nav>
        </div>
        <div className="mx-auto grid w-full max-w-[1180px] grid-cols-4 gap-8 px-5 max-[760px]:grid-cols-2">
          <div>
            <span className={FOOT_HEAD}>
              Product
            </span>
            <ul className={FOOT_LIST}>
              <li>
                <a className="hover:text-[#0b1b3f]" href="/about">
                  About
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="/trust">
                  Security &amp; compliance
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="#inside">
                  What&rsquo;s inside
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="#corridors">
                  Corridors
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="#calculator">
                  FX calculator
                </a>
              </li>
              <li>
                <Link className="hover:text-[#0b1b3f]" href="/docs">
                  Docs
                </Link>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="#partner-with-us">
                  Partner with us
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
                <a className="hover:text-[#0b1b3f]" href="https://send.smartremit.ai/portal/login">
                  Customers
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="/login">
                  Employee portal
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="/partner">
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
                <a className="hover:text-[#0b1b3f]" href="https://send.smartremit.ai/portal/login">
                  Create account
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="https://send.smartremit.ai/portal/login">
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
                  className="hover:text-[#0b1b3f]"
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {`WhatsApp: ${formatWaPhone(WA_PHONE)}`}
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="mailto:hello@smartremit.ai">
                  Email: hello@smartremit.ai
                </a>
              </li>
              <li>
                <a className="hover:text-[#0b1b3f]" href="mailto:support@smartremit.ai">
                  Support: support@smartremit.ai
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mx-auto mt-10 w-full max-w-[1180px] border-t border-[#dbe4f0] px-5 pt-6">
          <p className="max-w-[90ch] text-[12.5px] leading-relaxed text-[#52607a]">
            SmartRemit provides the technology platform — conversation, quoting,
            compliance screening, and orchestration. Partners are the licensed money
            transmitters and settle all funds on their own rails; SmartRemit never holds,
            receives, or disburses customer money. Exchange rates are indicative and locked
            when you confirm a transfer.
          </p>
          {/* Program-Fix 15 PR A: the legal drafts (Terms, Privacy, Legal). */}
          <nav aria-label="Legal" className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-[#52607a]">
            <a className="hover:text-[#0b1b3f]" href="/terms">
              Terms
            </a>
            <a className="hover:text-[#0b1b3f]" href="/privacy">
              Privacy
            </a>
            <a className="hover:text-[#0b1b3f]" href="/legal">
              Licensing &amp; your rights
            </a>
          </nav>
          <p className="mt-3 text-[12.5px] text-[#52607a]">{companyFooterLine(new Date().getFullYear())}</p>
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
