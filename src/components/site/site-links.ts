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

/** The "Log in" menu. Partners still go to /docs until the post-demo swap. */
export const LOGIN_MENU = [
  { href: '/account/login', title: 'Customers', sub: 'Track transfers & receipts' },
  { href: '/login', title: 'Employee portal', sub: 'Staff & partner dashboards' },
  { href: '/docs', title: 'Partners', sub: 'Integration docs & API' },
] as const;

export const REGISTER_HREF = '/account/register';
/** Phones (≤760 px) get a plain link here instead of the menu, as on the landing. */
export const LOGIN_HREF = '/account/login';

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
      { href: '/account/login', label: 'Customers' },
      { href: '/login', label: 'Employee portal' },
      { href: '/docs', label: 'Partners' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { href: '/account/register', label: 'Create account' },
      { href: '/account/login', label: 'Customer portal' },
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
