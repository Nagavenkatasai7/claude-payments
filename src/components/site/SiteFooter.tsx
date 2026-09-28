import BrandLogo from '@/app/landing/BrandLogo';
import SocialLinks from '@/app/landing/SocialLinks';
import { waLink, WA_MESSAGES, WA_PHONE, formatWaPhone } from '@/app/landing/wa';
import { CONTACT_EMAILS, FOOTER_COLUMNS, LEGAL_LINKS, type FooterLink } from './site-links';

// The landing's footer (src/app/page.tsx <footer>), replicated with ds tokens. Server component.
const FOOT_HEAD = 'mb-4 block text-[12px] font-bold uppercase tracking-[0.1em] text-ds-ink-muted';
const FOOT_LIST = 'flex flex-col gap-2.5 text-[14px] text-ds-ink-muted';
const FOOT_LINK = 'hover:text-ds-ink';

function Column({ heading, links }: { heading: string; links: readonly (FooterLink & { external?: boolean })[] }) {
  return (
    <div>
      <span className={FOOT_HEAD}>{heading}</span>
      <ul className={FOOT_LIST}>
        {links.map((l) => (
          <li key={`${l.href}|${l.label}`}>
            {l.external ? (
              <a className={FOOT_LINK} href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            ) : (
              <a className={FOOT_LINK} href={l.href}>
                {l.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  const contact = [
    { href: waLink(WA_MESSAGES.generic), label: `WhatsApp: ${formatWaPhone(WA_PHONE)}`, external: true },
    ...CONTACT_EMAILS,
  ];
  return (
    <footer className="border-t border-ds-border bg-ds-surface pt-[clamp(40px,6vw,64px)] pb-8">
      <div className="mx-auto mb-10 flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-6 px-5">
        <div className="flex flex-col items-start gap-3">
          <BrandLogo height={40} />
          <p className="text-[14px] text-ds-ink-muted">Global money transfers, made simpler.</p>
        </div>
        <nav aria-label="SmartRemit on social media">
          <SocialLinks />
        </nav>
      </div>
      <div className="mx-auto grid w-full max-w-[1180px] grid-cols-4 gap-8 px-5 max-[760px]:grid-cols-2">
        {FOOTER_COLUMNS.map((c) => (
          <Column key={c.heading} heading={c.heading} links={c.links} />
        ))}
        <Column heading="Contact" links={contact} />
      </div>
      <div className="mx-auto mt-10 w-full max-w-[1180px] border-t border-ds-border px-5 pt-6">
        <p className="max-w-[90ch] text-[12.5px] leading-relaxed text-ds-ink-faint">
          SmartRemit provides the technology platform — conversation, quoting, compliance screening, and
          orchestration. Partners are the licensed money transmitters and settle all funds on their own
          rails; SmartRemit never holds, receives, or disburses customer money. Exchange rates are
          indicative and locked when you confirm a transfer.
        </p>
        <nav aria-label="Legal" className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ds-ink-faint">
          {LEGAL_LINKS.map((l) => (
            <a key={l.href} className={FOOT_LINK} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
