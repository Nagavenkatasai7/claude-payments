import type { ReactNode } from 'react';

// Footer social links. Plain outbound <a>s with inline monochrome SVG glyphs:
// no embeds, widgets or third-party scripts, so the enforced CSP is untouched
// (links are navigation, not fetches). Each link carries its own aria-label;
// the glyph is decorative. Stroke glyphs for LinkedIn, Instagram, YouTube and
// Facebook follow Feather Icons (MIT); Substack is a simple drawn mark.

const SOCIALS: { name: string; href: string; glyph: ReactNode }[] = [
  {
    name: 'LinkedIn',
    href: 'https://www.linkedin.com/company/smartremit/',
    glyph: (
      <>
        <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
        <rect x="2" y="9" width="4" height="12" />
        <circle cx="4" cy="4" r="2" />
      </>
    ),
  },
  {
    name: 'Instagram',
    href: 'https://www.instagram.com/smartremit.ai',
    glyph: (
      <>
        <rect x="2" y="2" width="20" height="20" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <path d="M17.5 6.5h.01" />
      </>
    ),
  },
  {
    name: 'YouTube',
    href: 'https://www.youtube.com/@SmartRemit',
    glyph: (
      <>
        <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z" />
        <path d="M9.75 15.02l5.75-3.27-5.75-3.27v6.54z" />
      </>
    ),
  },
  {
    name: 'Facebook',
    href: 'https://www.facebook.com/profile.php?id=61594456710999',
    glyph: <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />,
  },
  {
    name: 'Substack',
    href: 'https://substack.com/@smartremit',
    glyph: (
      <>
        <path d="M5 4h14" />
        <path d="M5 8h14" />
        <path d="M5 12h14v8.5l-7-4-7 4V12z" />
      </>
    ),
  },
];

export default function SocialLinks() {
  return (
    <ul className="flex flex-wrap items-center gap-2.5">
      {SOCIALS.map((s) => (
        <li key={s.name}>
          <a
            className="grid h-10 w-10 place-items-center rounded-full border border-[#dbe4f0] bg-white text-[#475569] transition-colors duration-150 hover:border-[#0c5bd2]/40 hover:text-[#0c5bd2]"
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`SmartRemit on ${s.name}`}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              {s.glyph}
            </svg>
          </a>
        </li>
      ))}
    </ul>
  );
}
