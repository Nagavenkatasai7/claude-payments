import Link from 'next/link';
import BrandLogo from '@/app/landing/BrandLogo';
import WhatsAppIcon from '@/app/landing/WhatsAppIcon';
import { waLink, WA_MESSAGES } from '@/app/landing/wa';
import { LoginMenu } from './LoginMenu';
import { LOGIN_HREF, NAV_LINKS, REGISTER_HREF } from './site-links';

// The landing's sticky header (src/app/page.tsx <nav aria-label="Primary">), replicated with ds
// tokens for the pages that share the site shell. Same collapse order as the landing: section
// links, then Create account, then the Log in menu (a plain link on phones), then the WhatsApp
// label (icon only). The logo links home. Server component; LoginMenu is the one client island.

// Tailwind only generates classes it can read literally, so each landing breakpoint maps to a
// full class string here (never built from the number).
const HIDE: Record<(typeof NAV_LINKS)[number]['hide'], string> = {
  1180: 'max-[1180px]:hidden',
  760: 'max-[760px]:hidden',
};
const NAV_LINK = 'text-[14px] text-ds-ink-muted transition-colors hover:text-ds-ink';

export function SiteHeader() {
  return (
    <nav
      className="sticky top-0 z-50 border-b border-ds-border bg-ds-nav-bg backdrop-blur-[12px]"
      aria-label="Primary"
    >
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-5 px-5 py-3">
        <Link className="inline-flex shrink-0 items-center" href="/">
          <BrandLogo height={40} eager className="h-9 sm:h-10" />
        </Link>
        <div className="ml-auto flex items-center gap-5 max-[520px]:gap-3">
          {NAV_LINKS.map((l) => (
            <a key={l.href} className={`${NAV_LINK} ${HIDE[l.hide]}`} href={l.href}>
              {l.label}
            </a>
          ))}
          <LoginMenu />
          <a
            className="inline-flex min-h-11 items-center text-[14px] font-medium text-ds-ink-muted transition-colors hover:text-ds-ink min-[761px]:hidden"
            href={LOGIN_HREF}
          >
            Log in
          </a>
          <a
            className="inline-flex min-h-10 items-center rounded-full border border-ds-border-strong px-4 text-[13.5px] font-semibold text-ds-ink transition-[border-color,background-color] duration-150 hover:border-ds-primary/50 hover:bg-ds-surface max-[1023px]:hidden"
            href={REGISTER_HREF}
          >
            Create account
          </a>
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-ds-cta-whatsapp px-4 text-[13.5px] font-bold text-ds-on-whatsapp transition-[background-color,transform] duration-150 hover:bg-ds-cta-whatsapp-hover hover:[transform:translateY(-1px)] max-[520px]:min-h-11 max-[520px]:min-w-11 max-[520px]:justify-center max-[520px]:px-0"
            href={waLink(WA_MESSAGES.generic)}
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
  );
}
