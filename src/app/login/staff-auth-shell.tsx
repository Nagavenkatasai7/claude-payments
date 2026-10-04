import type { ReactNode } from 'react';
import Link from 'next/link';
import { KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import BrandLogo from '../landing/BrandLogo';
import { Card } from '@/components/ds';
import { CUSTOMER_PORTAL_LOGIN } from '@/components/site/site-links';

// The SmartRemit employee portal frame shared by /login and /login/mfa, in the landing look (ds
// tokens). SmartRemit is the only brand on the page (owner decision, 2026-10-04). Desktop (lg+): a
// brand panel beside the card. Phones: the logo above the card, no panel, so nothing scrolls sideways
// at 375 px. Server-only markup: no client JS beyond the form the page passes in.

const ROOT =
  'min-h-dvh bg-ds-ground font-sans leading-[1.6] text-ds-ink antialiased lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] ' +
  '[&_:focus-visible]:rounded-ds-focus [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[3px] [&_:focus-visible]:outline-ds-focus-ring';

const FACTS = [
  { icon: ShieldCheck, text: 'SmartRemit never holds customer funds.' },
  { icon: LockKeyhole, text: 'Customer details are encrypted at rest.' },
  { icon: KeyRound, text: 'Two-step sign-in protects every staff account.' },
] as const;

function BrandPanel() {
  return (
    <aside
      aria-label="About SmartRemit"
      className="relative hidden flex-col justify-between overflow-hidden border-r border-ds-border bg-[linear-gradient(160deg,var(--ds-surface)_0%,var(--ds-tint)_55%,var(--ds-icon-bg)_100%)] px-12 py-10 lg:flex"
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-ds-gradient-bar" />
      <Link href="/" className="inline-flex w-fit">
        <BrandLogo height={44} eager className="h-11" />
      </Link>
      <div className="max-w-md">
        <p className="text-[13px] font-semibold tracking-[0.08em] text-ds-accent uppercase">Employee portal</p>
        <p className="mt-3 text-[clamp(30px,3vw,40px)] leading-[1.15] font-extrabold tracking-[-0.025em] text-ds-ink">
          The SmartRemit workspace for our team.
        </p>
        <p className="mt-4 text-[16px] text-ds-ink-muted">
          Transfers, customers, compliance and support for SmartRemit, all in one place.
        </p>
        <ul className="mt-8 flex flex-col gap-3.5">
          {FACTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-[15px] font-medium text-ds-ink">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-ds-inner border border-ds-icon-ring bg-ds-icon-bg text-ds-icon-ink">
                <Icon aria-hidden="true" className="size-[18px]" />
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[13px] text-ds-ink-subtle">© SmartRemit.ai</p>
    </aside>
  );
}

export function StaffAuthShell({
  title,
  sub,
  children,
  footer,
}: {
  title: string;
  sub: string;
  children: ReactNode;
  /** Extra links under the card (the MFA page's "Start over"). */
  footer?: ReactNode;
}) {
  return (
    <main id="main" className={ROOT}>
      <BrandPanel />
      <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">
          <Link href="/" className="mb-8 flex justify-center lg:hidden">
            <BrandLogo height={40} eager className="h-9 sm:h-10" />
          </Link>
          <Card className="shadow-ds-pop">
            <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em] text-ds-ink">{title}</h1>
            <p className="mt-1.5 mb-6 text-[15px] text-ds-ink-muted">{sub}</p>
            {children}
          </Card>
          <div className="mt-6 flex flex-col items-center gap-2 text-center text-[14px] text-ds-ink-muted">
            {footer}
            <p>
              Sending money?{' '}
              <a href={CUSTOMER_PORTAL_LOGIN} className="font-semibold text-ds-primary underline-offset-4 hover:underline">
                Customer sign-in
              </a>
            </p>
            <Link href="/" className="font-semibold text-ds-primary underline-offset-4 hover:underline">
              Back to smartremit.ai
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
