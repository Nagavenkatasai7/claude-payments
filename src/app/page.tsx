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
import ScrollReveal from './landing/ScrollReveal';
import NavScroll from './landing/NavScroll';
import TiltCard from './landing/TiltCard';

// Self-hosted Inter, scoped to the landing tree only (applied on the .lp root),
// so it never touches the sh-* dashboard or .payapp themes.
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
    <div className={`lp ${inter.className}`}>
      {/* Sentinel for the frosted-nav IntersectionObserver. */}
      <div id="lp-nav-sentinel" aria-hidden="true" />
      <NavScroll />
      <ScrollReveal />

      {/* ============ NAV ============ */}
      <nav className="lp-nav" aria-label="Primary">
        <a className="lp-wordmark" href="#top">
          <span className="lp-wordmark-glyph" aria-hidden="true">
            ◈
          </span>
          SmartRemit
        </a>
        <div className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#countries">Countries</a>
          <a href="#faq">FAQ</a>
        </div>
        <a
          className="lp-btn-wa lp-btn-wa--compact"
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
        <section className="lp-hero">
          <div className="lp-aurora" aria-hidden="true" />
          <div className="lp-grain" aria-hidden="true" />
          <div className="lp-hero-inner">
            <div className="lp-hero-copy">
              <h1 className="lp-h1">
                Send money home.{' '}
                <span className="lp-h1-accent">Right from WhatsApp.</span>
              </h1>
              <p className="lp-subhead">
                No app to download, no forms to fill. Just chat with our
                assistant and money lands in their bank — across 8 countries, any
                direction, at live exchange rates.
              </p>
              <div className="lp-hero-cta">
                <a
                  className="lp-btn-wa lp-btn-wa--lg"
                  href={genericHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WhatsAppIcon size={22} />
                  <span>Send money on WhatsApp</span>
                </a>
                <p className="lp-microcopy">
                  No app to install · Live mid-market-style rate · Money
                  bank-to-bank
                </p>
              </div>
              <p className="lp-trustline">
                Bank-grade encryption · 8 countries, any direction
              </p>
            </div>

            {/* Glass WhatsApp chat mock */}
            <TiltCard className="lp-mock-tilt" max={5}>
              <div className="lp-mock lp-tier3" role="img" aria-label="Example WhatsApp chat with the SmartRemit assistant quoting a transfer of $500 to India">
                <div className="lp-mock-bar">
                  <span className="lp-mock-avatar" aria-hidden="true">
                    ◈
                  </span>
                  <span className="lp-mock-name">SmartRemit</span>
                  <span className="lp-mock-online">online</span>
                </div>
                <div className="lp-mock-body">
                  <div className="lp-bubble lp-bubble--in">
                    How much would you like to send?
                  </div>
                  <div className="lp-bubble lp-bubble--out">
                    Send $500 to my brother in India
                  </div>
                  <div className="lp-bubble lp-bubble--in lp-bubble--quote">
                    <strong>$500 → {heroInr}</strong>
                    <br />
                    rate 1 USD = {fmtRate(liveRate)} · fee $0 first transfer ·
                    arrives within minutes
                  </div>
                  <div className="lp-bubble lp-bubble--in lp-bubble--ok">
                    Delivered ✓
                  </div>
                </div>
              </div>
              <div className="lp-chip lp-chip--fx" aria-hidden="true">
                <span className="lp-chip-dot" /> FX live
              </div>
              <div className="lp-chip lp-chip--countries" aria-hidden="true">
                8 countries
              </div>
            </TiltCard>
          </div>
        </section>

        {/* ============ LIVE RATE STRIP / CALCULATOR ============ */}
        <section className="lp-rate lp-reveal" aria-labelledby="rate-h">
          <div className="lp-section-inner lp-rate-grid">
            <div>
              <h2 id="rate-h" className="lp-h2">
                See the real rate before you send a cent.
              </h2>
              <p className="lp-lead">
                Today, 1 USD = {fmtRate(liveRate)}{' '}
                <span className="lp-muted">(live mid-market rate).</span>
              </p>
            </div>
            <RateCalculator liveRate={liveRate} />
          </div>
        </section>

        {/* ============ TRUST BAR ============ */}
        <section className="lp-trustbar lp-reveal" aria-label="Why you can trust SmartRemit">
          <div className="lp-section-inner">
            <ul className="lp-trustbar-chips">
              <li>
                <LockIcon /> Bank-grade encryption
              </li>
              <li>
                <RateIcon /> Live exchange rates
              </li>
              <li>
                <GlobeIcon /> 8 countries · any direction
              </li>
              <li>
                <BankIcon /> Money bank-to-bank
              </li>
            </ul>
            {/* PLACEHOLDER: replace these grey slots with real press/partner logos. */}
            <div className="lp-logos" aria-label="As featured in — placeholder press logos">
              <span className="lp-logos-label">As featured in</span>
              <div className="lp-logo-slots">
                <span className="lp-logo-slot" />
                <span className="lp-logo-slot" />
                <span className="lp-logo-slot" />
                <span className="lp-logo-slot" />
              </div>
            </div>
          </div>
        </section>

        {/* ============ WHY SMARTREMIT ============ */}
        <section className="lp-value lp-reveal" aria-labelledby="value-h">
          <div className="lp-section-inner">
            <h2 id="value-h" className="lp-h2 lp-center">
              A better way to send money to family.
            </h2>
            <div className="lp-value-grid">
              <TiltCard className="lp-card lp-tier2">
                <h3 className="lp-card-h">It&rsquo;s just WhatsApp.</h3>
                <p>
                  No app, no signup forms, no waiting room. Chat the way you
                  already do, and you&rsquo;re done.
                </p>
              </TiltCard>
              <TiltCard className="lp-card lp-tier2">
                <h3 className="lp-card-h">The honest rate.</h3>
                <p>
                  Banks bury their margin in a bad exchange rate. We show you the
                  real rate and the exact fee, every time.
                </p>
              </TiltCard>
              <TiltCard className="lp-card lp-tier2">
                <h3 className="lp-card-h">Lands in minutes.</h3>
                <p>
                  Money goes straight to their bank account — typically within
                  minutes, not days.
                </p>
              </TiltCard>
              <TiltCard className="lp-card lp-tier2">
                <h3 className="lp-card-h">Send anywhere, both ways.</h3>
                <p>
                  US, Canada, UK, UAE, Singapore, Australia, New Zealand, India
                  — any direction.
                </p>
              </TiltCard>
            </div>
          </div>
        </section>

        {/* ============ HOW IT WORKS ============ */}
        <section id="how" className="lp-how lp-reveal" aria-labelledby="how-h">
          <div className="lp-section-inner">
            <h2 id="how-h" className="lp-h2 lp-center">
              Send money in three messages.
            </h2>
            <ol className="lp-how-grid">
              <li className="lp-step lp-tier2">
                <span className="lp-step-num" aria-hidden="true">
                  1
                </span>
                <h3 className="lp-card-h">Open WhatsApp.</h3>
                <p>
                  Tap the button. A chat with our assistant opens — no download,
                  no account to create.
                </p>
              </li>
              <li className="lp-step lp-tier2">
                <span className="lp-step-num" aria-hidden="true">
                  2
                </span>
                <h3 className="lp-card-h">Tell us who and how much.</h3>
                <p>
                  Just their name, their number, and the amount. We lock in the
                  live rate and show you the fee up front.
                </p>
              </li>
              <li className="lp-step lp-tier2">
                <span className="lp-step-num" aria-hidden="true">
                  3
                </span>
                <h3 className="lp-card-h">They get paid.</h3>
                <p>
                  Approve with one tap. Money lands in their bank account,
                  bank-to-bank.
                </p>
              </li>
            </ol>
            <div className="lp-how-close">
              <p>That&rsquo;s it — no app, no paperwork.</p>
              <a
                className="lp-btn-wa"
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
          className="lp-corridors lp-reveal"
          aria-labelledby="corr-h"
        >
          <div className="lp-section-inner">
            <h2 id="corr-h" className="lp-h2 lp-center">
              8 countries. Any direction.
            </h2>
            <p className="lp-sub lp-center">
              Send and receive between all of these — pick your route and start a
              chat.
            </p>
            <div className="lp-corridor-bento">
              <div
                className="lp-corridor-map lp-tier2"
                role="img"
                aria-label="A route map connecting the 8 supported countries — United States, Canada, United Kingdom, UAE, Singapore, Australia, New Zealand and India — with money able to flow in any direction between them."
              >
                <svg
                  viewBox="0 0 400 220"
                  className="lp-map-svg"
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
                <span className="lp-map-caption">Any route, both ways</span>
              </div>

              <div className="lp-corridor-tiles">
                {COUNTRIES.map((c) => (
                  <a
                    key={c.short}
                    className="lp-corridor-tile lp-tier1"
                    href={waLink(corridorMessage(c.name))}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="lp-flag"
                      src={`/flags/${c.code}.svg`}
                      alt=""
                      width={36}
                      height={27}
                      loading="lazy"
                    />
                    <span className="lp-corridor-name">{c.short}</span>
                  </a>
                ))}
              </div>

              <div className="lp-corridor-facts">
                <span className="lp-fact lp-tier1">Live FX</span>
                <span className="lp-fact lp-tier1">Bank-to-bank</span>
                <span className="lp-fact lp-tier1">Minutes, not days</span>
                <span className="lp-fact lp-tier1">WhatsApp-native</span>
              </div>
            </div>
          </div>
        </section>

        {/* ============ TRANSPARENT PRICING ============ */}
        <section className="lp-pricing lp-reveal" aria-labelledby="price-h">
          <div className="lp-section-inner">
            <h2 id="price-h" className="lp-h2 lp-center">
              What you see is what you send.
            </h2>
            <p className="lp-sub lp-center">
              No hidden markup baked into the rate. Just the live exchange rate
              plus a clear, flat fee.
            </p>
            <div className="lp-pricing-grid">
              <div className="lp-compare lp-tier2">
                <div className="lp-compare-row">
                  <span className="lp-compare-label">SmartRemit</span>
                  <div className="lp-bar lp-bar--us" style={{ width: '32%' }}>
                    <span>live rate + $1.99 flat fee</span>
                  </div>
                </div>
                <div className="lp-compare-row">
                  <span className="lp-compare-label">Typical bank</span>
                  <div className="lp-bar lp-bar--bank" style={{ width: '88%' }}>
                    <span>rate marked up 3–5% + fees</span>
                  </div>
                </div>
                <p className="lp-compare-caption">
                  Illustrative example — your bank&rsquo;s markup may vary.
                </p>
              </div>
              <div className="lp-pricing-facts lp-tier2">
                <p className="lp-pricing-headline">
                  Your first transfer is free.
                </p>
                <p>
                  After that, $1.99 per bank transfer. Send $10 to $2,999 per
                  transfer.
                </p>
                <a
                  className="lp-btn-wa lp-btn-wa--block"
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
        <section className="lp-safety lp-reveal" aria-labelledby="safety-h">
          <div className="lp-section-inner">
            <h2 id="safety-h" className="lp-h2 lp-center">
              Built to be trusted with your money.
            </h2>
            <div className="lp-safety-grid">
              <div className="lp-card lp-tier2">
                <h3 className="lp-card-h">Encrypted end to end.</h3>
                <p>
                  Your conversation runs over WhatsApp&rsquo;s encryption, and
                  your data is never sold or shared.
                </p>
              </div>
              <div className="lp-card lp-tier2">
                <h3 className="lp-card-h">Transparent by design.</h3>
                <p>
                  You see the rate, the fee, and exactly what your recipient gets
                  — before you confirm. Nothing moves until you tap approve.
                </p>
              </div>
              <div className="lp-card lp-tier2">
                <h3 className="lp-card-h">Bank-to-bank, every time.</h3>
                <p>
                  Funds go directly between bank accounts. We never ask for card
                  details in chat.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ============ SOCIAL PROOF (PLACEHOLDER) ============ */}
        <section className="lp-proof lp-reveal" aria-labelledby="proof-h">
          <div className="lp-section-inner">
            <h2 id="proof-h" className="lp-h2 lp-center">
              Built for families who send money home.
            </h2>
            {/* PLACEHOLDER: replace each slot with a real, attributable customer
                quote. Do NOT invent quotes, names, photos, or star ratings. */}
            <div className="lp-proof-grid">
              <figure className="lp-proof-card lp-tier2">
                <blockquote>
                  [PLACEHOLDER testimonial — replace with a real, attributable
                  quote]
                </blockquote>
                <figcaption>— [Name, city]</figcaption>
              </figure>
              <figure className="lp-proof-card lp-tier2">
                <blockquote>
                  [PLACEHOLDER testimonial — replace with a real, attributable
                  quote]
                </blockquote>
                <figcaption>— [Name, city]</figcaption>
              </figure>
              <figure className="lp-proof-card lp-tier2">
                <blockquote>
                  [PLACEHOLDER testimonial — replace with a real, attributable
                  quote]
                </blockquote>
                <figcaption>— [Name, city]</figcaption>
              </figure>
            </div>
            <p className="lp-center lp-muted">
              We&rsquo;d love to earn your trust — try a first transfer free.
            </p>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section id="faq" className="lp-faq lp-reveal" aria-labelledby="faq-h">
          <div className="lp-section-inner lp-faq-inner">
            <h2 id="faq-h" className="lp-h2 lp-center">
              Questions, answered.
            </h2>
            <details className="lp-faq-item lp-tier1">
              <summary>Is it safe?</summary>
              <p>
                Yes. Your chat runs over WhatsApp&rsquo;s encryption, money moves
                bank-to-bank, and nothing is sent until you approve it in the
                chat.
              </p>
            </details>
            <details className="lp-faq-item lp-tier1">
              <summary>What does it cost?</summary>
              <p>
                Your first transfer is free. After that it&rsquo;s a flat $1.99
                per bank transfer, plus the live exchange rate — no hidden
                markup.
              </p>
            </details>
            <details className="lp-faq-item lp-tier1">
              <summary>How fast does it arrive?</summary>
              <p>
                Most transfers land in the recipient&rsquo;s bank account within
                minutes.
              </p>
            </details>
            <details className="lp-faq-item lp-tier1">
              <summary>Which countries can I send to?</summary>
              <p>
                US, Canada, UK, UAE, Singapore, Australia, New Zealand, and India
                — in any direction.
              </p>
            </details>
            <details className="lp-faq-item lp-tier1">
              <summary>Do I need to download an app?</summary>
              <p>
                No. Everything happens inside WhatsApp, an app you almost
                certainly already have.
              </p>
            </details>
            <details className="lp-faq-item lp-tier1">
              <summary>What do I need to get started?</summary>
              <p>
                Just your recipient&rsquo;s name, their WhatsApp number, and how
                much you&rsquo;d like to send. You&rsquo;ll enter their bank
                details securely on the payment page — never in the chat.
              </p>
            </details>
          </div>
        </section>

        {/* ============ FINAL CTA BAND ============ */}
        <section className="lp-final lp-reveal" aria-labelledby="final-h">
          <div className="lp-aurora lp-aurora--final" aria-hidden="true" />
          <div className="lp-section-inner lp-final-inner">
            <h2 id="final-h" className="lp-h2">
              Your family is one message away.
            </h2>
            <p className="lp-sub">
              Send money home in the time it takes to type a text.
            </p>
            <a
              className="lp-btn-wa lp-btn-wa--lg"
              href={genericHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <WhatsAppIcon size={22} />
              <span>Send money on WhatsApp</span>
            </a>
          </div>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer className="lp-footer">
        <div className="lp-section-inner lp-footer-grid">
          <div className="lp-footer-col">
            <span className="lp-footer-h">Countries</span>
            <ul>
              {COUNTRIES.map((c) => (
                <li key={c.short}>{c.name}</li>
              ))}
            </ul>
          </div>
          <div className="lp-footer-col">
            <span className="lp-footer-h">Links</span>
            <ul>
              <li>
                <a href="#how">How it works</a>
              </li>
              <li>
                <a href="#countries">Countries</a>
              </li>
              <li>
                <a href="#faq">FAQ</a>
              </li>
            </ul>
          </div>
          <div className="lp-footer-col">
            <span className="lp-footer-h">Contact</span>
            <ul>
              <li>
                <a href={genericHref} target="_blank" rel="noopener noreferrer">
                  Chat us on WhatsApp: +1 555 629 8293
                </a>
              </li>
              {/* PLACEHOLDER: replace with a real support email address. */}
              <li>Email: [PLACEHOLDER support email]</li>
            </ul>
          </div>
          <div className="lp-footer-col">
            <span className="lp-footer-h">Legal</span>
            {/* PLACEHOLDER: real licensing & regulatory disclosures go here. Do
                NOT add fabricated regulatory badges or licence numbers. */}
            <p className="lp-footer-legal">
              SmartRemit is a demonstration money-transfer service.{' '}
              [PLACEHOLDER: licensing &amp; regulatory disclosures]. Exchange
              rates are indicative and locked at the time you confirm a transfer.
            </p>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span className="lp-wordmark-glyph" aria-hidden="true">
            ◈
          </span>{' '}
          SmartRemit · Send money home, right from WhatsApp.
        </div>
      </footer>

      {/* ============ MOBILE STICKY CTA (≤600px only, via CSS) ============ */}
      <a
        className="lp-sticky-cta lp-btn-wa"
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
