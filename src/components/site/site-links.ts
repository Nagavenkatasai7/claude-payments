// The ONE list of shared site-shell links (UI redesign M4). It replicates the landing's header
// (src/app/page.tsx LoginMenu + <nav>) and footer, with the landing's in-page anchors written as
// '/#…' so they work from any page. tests/site-shell.test.ts pins parity with the landing in both
// directions. The new docs and trust pages are deliberately NOT linked until the post-demo swap
// (tests/docs-next-unlinked.test.ts).

/** Header section links. `hide` is the landing breakpoint at which the link collapses. */
export const NAV_LINKS = [
  { href: '/#inside', label: 'What’s inside', hide: 1180 },
  { href: '/#calculator', label: 'Calculator', hide: 1180 },
  { href: '/#waitlist', label: 'Join waitlist', hide: 760 },
  { href: '/#partner-with-us', label: 'Partner with us', hide: 760 },
  { href: '/about', label: 'About', hide: 760 },
] as const;

/**
 * SmartRemit's own customer portal (one customer portal, Oct 2): every customer link on the main site
 * opens it, and the first WhatsApp-code sign-in creates the account. `send` is the default tenant's
 * partner_sites slug; a slug is claimed once and a released one is never reused
 * (src/lib/partner-slug-policy.ts), so the address is stable. The legacy /account/login stays for
 * customers of partners without a portal and for old bookmarks.
 */
export const CUSTOMER_PORTAL_LOGIN = 'https://send.smartremit.ai/portal/login';

/** The "Log in" menu. Partners go to the partner dashboard; the docs stay in the footer. */
export const LOGIN_MENU = [
  { href: CUSTOMER_PORTAL_LOGIN, title: 'Customers', sub: 'Track transfers & receipts' },
  { href: '/login', title: 'Employee portal', sub: 'Staff & partner dashboards' },
  { href: '/partner', title: 'Partners', sub: 'Partner dashboard & API keys' },
] as const;

export const REGISTER_HREF = CUSTOMER_PORTAL_LOGIN;
/** Phones (≤760 px) get a plain link here instead of the menu, as on the landing. */
export const LOGIN_HREF = CUSTOMER_PORTAL_LOGIN;

export type FooterLink = { href: string; label: string };
export type FooterColumn = { heading: string; links: readonly FooterLink[] };

/** Footer columns without the Contact column (it is built from the WhatsApp helpers). */
export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    heading: 'Product',
    links: [
      { href: '/about', label: 'About' },
      { href: '/#inside', label: 'What’s inside' },
      { href: '/#corridors', label: 'Corridors' },
      { href: '/#calculator', label: 'FX calculator' },
      { href: '/docs', label: 'Partner docs' },
      { href: '/#partner-with-us', label: 'Partner with us' },
    ],
  },
  {
    heading: 'Log in',
    links: [
      { href: CUSTOMER_PORTAL_LOGIN, label: 'Customers' },
      { href: '/login', label: 'Employee portal' },
      { href: '/partner', label: 'Partners' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { href: CUSTOMER_PORTAL_LOGIN, label: 'Create account' },
      { href: CUSTOMER_PORTAL_LOGIN, label: 'Customer portal' },
    ],
  },
];

export const CONTACT_EMAILS = [
  { href: 'mailto:hello@smartremit.ai', label: 'Email: hello@smartremit.ai' },
  { href: 'mailto:support@smartremit.ai', label: 'Support: support@smartremit.ai' },
] as const;

export const LEGAL_LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/legal', label: 'Licensing & your rights' },
] as const;
