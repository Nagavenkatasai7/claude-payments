import type { Metadata } from 'next';
import Link from 'next/link';
import { Inter } from 'next/font/google';
import { waLink } from '../landing/wa';
import WhatsAppIcon from '../landing/WhatsAppIcon';

// Public /about page — the story + a product-walkthrough video. Styled with the
// SAME inline-Tailwind dark conventions as the landing (no shared .lp class
// system; the tokens are literal hex). Copy is adversarially fact-checked: it
// must NEVER imply SmartRemit is itself a licensed money transmitter or bank,
// never overclaim custody/sanctions/delivery, and must carry the honest
// demonstration-status note (money rails are simulated today).

const inter = Inter({ subsets: ['latin'], display: 'swap' });

// The explainer video. Same-origin /public today; swap to a Vercel Blob https
// URL later (the CSP media-src already allows that host) — one-line change.
const ABOUT_VIDEO_SRC = '/about-demo.mp4';
const ABOUT_VIDEO_POSTER = '/about-poster.svg';

const WA_HREF = waLink('Hi! I would like to send money home with SmartRemit.');

export const metadata: Metadata = {
  title: 'About SmartRemit — non-custodial remittance infrastructure',
  description:
    'SmartRemit is non-custodial technology that lets people send money home by chatting on WhatsApp, while licensed partners move the funds. Watch how one transfer works, start to finish.',
};

const ROOT =
  `${inter.className} min-h-svh overflow-x-hidden bg-[#050607] leading-[1.6] text-[#f5f7f8] antialiased ` +
  '[--lp-text-100:#f5f7f8] [--lp-text-300:#8b94a0] ' +
  '[&_:focus-visible]:rounded-[6px] [&_:focus-visible]:[outline-offset:3px] [&_:focus-visible]:[outline:2px_solid_#25d366]';

const SECTION = 'mx-auto w-full max-w-[1000px] px-5';
const KICKER = 'text-[13px] font-semibold uppercase tracking-[0.14em] text-[#25d366]';
const CARD = 'rounded-2xl border border-white/10 bg-[#0b0e12] p-6';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[14px] font-bold text-[#25d366] tabular-nums">
        {n}
      </span>
      <div>
        <div className="text-[16px] font-semibold text-[#f5f7f8]">{title}</div>
        <p className="mt-1 text-[15px] text-[#aeb6c0]">{children}</p>
      </div>
    </li>
  );
}

function Pillar({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={CARD}>
      <div className="text-[16px] font-semibold text-[#f5f7f8]">{title}</div>
      <p className="mt-2 text-[15px] text-[#aeb6c0]">{children}</p>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className={ROOT}>
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#050607]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-5 py-3.5">
          <Link href="/" className="text-[17px] font-semibold tracking-[-0.02em]">
            Smart<span className="text-[#25d366]">Remit</span>
          </Link>
          <Link href="/" className="ml-auto text-[14px] text-[#8b94a0] transition-colors hover:text-[#f5f7f8]">
            ← Back to home
          </Link>
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[#25d366] px-4 text-[13.5px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]"
            href={WA_HREF}
            target="_blank"
            rel="noopener noreferrer"
          >
            <WhatsAppIcon size={16} />
            <span>Start on WhatsApp</span>
          </a>
        </div>
      </header>

      <main>
        {/* Hero / mission */}
        <section className="px-5 pt-[clamp(48px,7vw,96px)] pb-[clamp(28px,4vw,48px)]">
          <div className="mx-auto w-full max-w-[1000px]">
            <span className={KICKER}>About SmartRemit</span>
            <h1 className="mt-3 text-balance text-[clamp(34px,5.5vw,60px)] font-semibold leading-[1.06] tracking-[-0.03em]">
              Money home, in a message.
            </h1>
            <p className="mt-5 max-w-[680px] text-[clamp(16px,2.2vw,20px)] text-[#aeb6c0]">
              {`Sending money to family across borders should feel as simple as texting them. SmartRemit makes the whole thing happen inside a WhatsApp conversation — no app to install, no forms to wrestle with.`}
            </p>
            <p className="mt-4 max-w-[680px] text-[16px] text-[#8b94a0]">
              {`SmartRemit is non-custodial technology infrastructure — not a bank and not a money transmitter. We orchestrate the conversation, the quote, the compliance checks and the secure pay page; licensed money-transmitter partners are the ones who actually move and settle the funds on their own regulated rails. We never hold your money.`}
            </p>
          </div>
        </section>

        {/* Video */}
        <section className="px-5 pb-[clamp(40px,6vw,72px)]">
          <div className="mx-auto w-full max-w-[1000px]">
            <p className="text-[15px] font-medium text-[#8b94a0]">See it in two minutes.</p>
            <div className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
              <video
                controls
                preload="metadata"
                poster={ABOUT_VIDEO_POSTER}
                className="aspect-video h-auto w-full"
                aria-label="SmartRemit product walkthrough"
              >
                <source src={ABOUT_VIDEO_SRC} type="video/mp4" />
                Your browser does not support the video tag. You can still read how it works below.
              </video>
            </div>
            <p className="mt-3 text-[14px] text-[#5b6470]">How one transfer works, start to finish.</p>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-white/[0.07] py-[clamp(48px,7vw,96px)]">
          <div className={SECTION}>
            <span className={KICKER}>How it works</span>
            <h2 className="mt-3 text-[clamp(26px,3.6vw,40px)] font-semibold tracking-[-0.02em]">
              How a send works.
            </h2>
            <ol className="mt-8 grid gap-6">
              <Step n={1} title="Start in WhatsApp">
                {`You message the SmartRemit number. An AI agent greets you and asks how much you want to send, to whom, and where.`}
              </Step>
              <Step n={2} title="Get a locked quote">
                {`The agent fetches a live mid-market exchange rate and adds a clear, flat fee — your first transfer is free, then it's a low flat fee. The rate you approve is the rate that's used; there's no hidden markup baked into it.`}
              </Step>
              <Step n={3} title="Approve & pay securely">
                {`You tap one button to open a secure, branded pay page, enter the recipient's payout details, clear a one-time passcode, and pay the licensed partner. SmartRemit never receives or holds your money — the partner's rail processes the payment.`}
              </Step>
              <Step n={4} title="Compliance runs every time">
                {`A sanctions screen runs on every transfer and cannot be switched off. A match stops the transfer before it's ever created; a flag routes it to a human reviewer; cleared transfers move on.`}
              </Step>
              <Step n={5} title="The partner settles">
                {`Once payment is taken, SmartRemit sends the licensed partner a cryptographically signed settlement instruction. When the partner's rail settles the payout, it signs a confirmation back — and the transfer is marked delivered.`}
              </Step>
              <Step n={6} title="Everyone gets confirmation">
                {`You and your recipient both get a WhatsApp message when the money is on its way. You can track status, repeat a past send, or request a refund — all from the same chat or your web account.`}
              </Step>
            </ol>
          </div>
        </section>

        {/* The platform (partners) */}
        <section className="border-t border-white/[0.07] py-[clamp(48px,7vw,96px)]">
          <div className={SECTION}>
            <span className={KICKER}>For partners</span>
            <h2 className="mt-3 text-[clamp(26px,3.6vw,40px)] font-semibold tracking-[-0.02em]">
              White-label rails for the licensed transmitter.
            </h2>
            <p className="mt-5 max-w-[760px] text-[17px] text-[#aeb6c0]">
              {`SmartRemit is multi-tenant infrastructure: one platform serves many partners, each with its own brand, WhatsApp number, settlement rail, rates and isolated dashboard. The licensed partner keeps the license and the funds flow — SmartRemit orchestrates everything around the money.`}
            </p>
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              <Pillar title="A branded WhatsApp agent + pay page">
                {`Your customers chat with your brand and pay on a hosted, secure page — you bring your own WhatsApp number.`}
              </Pillar>
              <Pillar title="Signed settlement webhooks">
                {`Instructions out and callbacks in are HMAC-signed and verified fail-closed — an invalid signature is rejected.`}
              </Pillar>
              <Pillar title="REST API + idempotent transfers">
                {`Create transfers over a Bearer-keyed API, pinned to your tenant, with idempotency keys so a retry never duplicates a transfer.`}
              </Pillar>
              <Pillar title="Self-service dashboard">
                {`Transactions, stuck-money recovery, compliance and KYC review, analytics, rates, team and API keys — scoped to your tenant.`}
              </Pillar>
            </div>
            <Link
              href="/#partner-with-us"
              className="mt-8 inline-flex min-h-11 items-center rounded-full border border-white/15 px-5 text-[14px] font-semibold text-[#f5f7f8] transition-[border-color,background-color] duration-150 hover:border-white/40 hover:bg-white/[0.04]"
            >
              Partner with us →
            </Link>
          </div>
        </section>

        {/* Trust & compliance */}
        <section className="border-t border-white/[0.07] py-[clamp(48px,7vw,96px)]">
          <div className={SECTION}>
            <span className={KICKER}>Trust &amp; compliance</span>
            <h2 className="mt-3 text-[clamp(26px,3.6vw,40px)] font-semibold tracking-[-0.02em]">
              Built so the money path is safe by construction.
            </h2>
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              <Pillar title="Non-custodial by design">
                {`SmartRemit never holds, receives or disburses your funds. The money paths only ever produce signed instructions to the licensed partner who settles.`}
              </Pillar>
              <Pillar title="Sanctions screening always on">
                {`Screening runs on every transfer and is structurally impossible to switch off, in every mode. (In today's demonstration it runs against a built-in reference rule set, not yet a live commercial AML feed.)`}
              </Pillar>
              <Pillar title="Licensed partners move the money">
                {`The regulated money-transmitter partner holds the license and operates the rails. SmartRemit is the technology layer around them.`}
              </Pillar>
              <Pillar title="Encrypted at rest, masked by default">
                {`Payout destinations, recipient legal names, customer data and integration secrets are AES-256-GCM encrypted at rest and masked in dashboards; staff reveals are audited.`}
              </Pillar>
              <Pillar title="Durable & idempotent">
                {`Every external effect is a transactional outbox row with automatic retry — nothing is silently lost, and crash-replays never duplicate a transfer.`}
              </Pillar>
              <Pillar title="Full audit trail">
                {`KYC decisions, blocked attempts and sensitive-data reveals are written to an append-only, per-partner audit log.`}
              </Pillar>
            </div>
          </div>
        </section>

        {/* Honest status note */}
        <section className="px-5 py-[clamp(32px,5vw,56px)]">
          <div className="mx-auto w-full max-w-[1000px]">
            <div className="rounded-2xl border border-[#22d3ee]/25 bg-[#22d3ee]/[0.06] p-6">
              <div className="text-[15px] font-semibold text-[#f5f7f8]">A note on where we are today</div>
              <p className="mt-2 text-[15px] text-[#aeb6c0]">
                {`SmartRemit is a working demonstration of production-grade remittance infrastructure. The AI conversation, live FX quoting, signed instruction-and-callback loop, durable processing, dashboards and WhatsApp notifications are real. Actual fund movement, the production identity-verification vendor, a commercial sanctions feed, and a live payout rail are simulated today — a reference "simulator" rail runs the exact signed loop a production rail would. We'll only describe those as live once they are.`}
              </p>
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t border-white/[0.07] px-5 py-[clamp(48px,7vw,96px)]">
          <div className="mx-auto w-full max-w-[1000px] text-center">
            <h2 className="text-[clamp(26px,3.6vw,42px)] font-semibold tracking-[-0.02em]">
              Your family is one message away.
            </h2>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <a
                className="inline-flex min-h-12 items-center gap-2 rounded-full bg-[#25d366] px-6 text-[15px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]"
                href={WA_HREF}
                target="_blank"
                rel="noopener noreferrer"
              >
                <WhatsAppIcon size={18} />
                <span>Start on WhatsApp</span>
              </a>
              <Link
                href="/"
                className="inline-flex min-h-12 items-center rounded-full border border-white/15 px-6 text-[15px] font-semibold text-[#f5f7f8] transition-[border-color,background-color] duration-150 hover:border-white/40 hover:bg-white/[0.04]"
              >
                Back to home
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#07090b] py-8">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-3 px-5 text-[13px] text-[#5b6470]">
          <span>
            Smart<span className="text-[#8b94a0]">Remit</span> — non-custodial remittance infrastructure.
          </span>
          <span>[Placeholder: licensing &amp; regulatory disclosures]</span>
        </div>
      </footer>
    </div>
  );
}
