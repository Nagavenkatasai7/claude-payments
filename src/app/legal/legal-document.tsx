import type { ReactNode } from 'react';
import Link from 'next/link';
import { SkipLink } from '@/components/skip-link';
import { LEGAL_DRAFT_BANNER, LEGAL_DRAFT_VERSION, type LegalDraft } from '@/lib/legal/drafts';

// Program-Fix 15 PR A — the shared renderer for /terms, /privacy and /legal.
// Not a route (only page.tsx is routable). A plain synchronous server
// component with no next/font, so tests/legal-pages.test.ts can render it
// statically. Styled on the /docs shadcn tokens. Long words wrap
// (break-words) so nothing scrolls sideways on a 390px phone.

const LEGAL_LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/legal', label: 'Legal' },
] as const;

/** One draft document: its sections, each with an anchor id. */
export function LegalDraftSections({ draft, headingLevel }: { draft: LegalDraft; headingLevel: 'h2' | 'h3' }) {
  const Heading = headingLevel;
  return (
    <div className="space-y-8">
      {draft.sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${draft.id}-${s.id}-h`} className="scroll-mt-6">
          <Heading id={`${draft.id}-${s.id}-h`} className="text-lg font-semibold tracking-tight">
            {s.heading}
          </Heading>
          {s.paragraphs.map((p, i) => (
            <p key={i} className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              {p}
            </p>
          ))}
          {s.bullets && (
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-muted-foreground">
              {s.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** Page chrome: header, the draft banner, one h1, the body, and footer links. */
export function LegalPageShell({
  current,
  title,
  summary,
  children,
}: {
  current: '/terms' | '/privacy' | '/legal';
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-background font-sans text-foreground antialiased">
      <SkipLink />
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            SmartRemit <span className="font-normal text-muted-foreground">/ legal</span>
          </Link>
          <nav aria-label="Legal pages" className="flex items-center gap-4 text-sm">
            {LEGAL_LINKS.filter((l) => l.href !== current).map((l) => (
              <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl break-words px-5 py-10">
        <div
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">{LEGAL_DRAFT_BANNER}</p>
          <p className="mt-1">
            This text is a working draft published for review. It may change before it takes effect.
            Version <code className="font-mono">{LEGAL_DRAFT_VERSION}</code>.
          </p>
        </div>

        <h1 className="mt-8 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-muted-foreground">{summary}</p>

        <div className="mt-10">{children}</div>
      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-6 text-sm text-muted-foreground">
          {LEGAL_LINKS.map((l) =>
            l.href === current ? (
              <span key={l.href} aria-current="page" className="font-medium text-foreground">
                {l.label}
              </span>
            ) : (
              <Link key={l.href} href={l.href} className="hover:text-foreground">
                {l.label}
              </Link>
            ),
          )}
          <Link href="/about" className="hover:text-foreground">
            About
          </Link>
        </div>
      </footer>
    </div>
  );
}
