import Link from 'next/link';
import { GUIDES } from '@/content/docs/registry';

// The guide list. Desktop: a sticky sidebar. Phone: a <details> disclosure (no client JS).
// Only one of the two is displayed at a time, so assistive tech sees a single "Guides" nav.
const LINK = 'block rounded-ds-focus px-2 py-1.5 text-[14px] text-ds-ink-muted hover:bg-ds-tint hover:text-ds-ink';

function GuideList() {
  return (
    <ul className="flex flex-col gap-0.5">
      <li>
        <Link className={LINK} href="/docs-next">
          Overview
        </Link>
      </li>
      {GUIDES.map((g) => (
        <li key={g.slug}>
          <Link className={LINK} href={`/docs-next/${g.slug}`}>
            {g.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DocsNav() {
  return (
    <>
      <nav aria-label="Guides" className="md:hidden">
        <details className="rounded-ds-inner border border-ds-border bg-ds-surface">
          <summary className="cursor-pointer px-4 py-3 text-[15px] font-semibold text-ds-ink">All guides</summary>
          <div className="border-t border-ds-border p-2">
            <GuideList />
          </div>
        </details>
      </nav>
      <nav aria-label="Guides" className="hidden md:block">
        <div className="sticky top-24">
          <span className="mb-3 block px-2 text-[12px] font-bold uppercase tracking-[0.1em] text-ds-ink-muted">Guides</span>
          <GuideList />
        </div>
      </nav>
    </>
  );
}
