import type { MDXComponents } from 'mdx/types';
import { ErrorStatusTable, Fact, GuideLink, TemplateCatalog } from '@/components/docs/mdx-blocks';
import { dsCn } from '@/lib/ui/ds-cn';

// Required by @next/mdx on the App Router (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/mdx-components.md). Maps markdown to ds-token-styled elements (the landing
// look) and exposes the code-backed blocks the partner guides use WITHOUT imports (the content
// guard forbids import/export in .mdx). Server-only: no client JS, no inline script.

const CODE = 'rounded-ds-focus bg-ds-tint px-1 py-0.5 font-mono text-[0.9em] text-ds-ink break-words';
const LINK = 'font-semibold text-ds-primary hover:underline';

const components: MDXComponents = {
  h2: (p) => <h2 className="mt-10 scroll-mt-24 text-2xl font-bold tracking-[-0.015em] text-ds-ink" {...p} />,
  h3: (p) => <h3 className="mt-8 scroll-mt-24 text-lg font-semibold text-ds-ink" {...p} />,
  h4: (p) => <h4 className="mt-6 font-semibold text-ds-ink" {...p} />,
  p: (p) => <p className="mt-4 leading-relaxed text-ds-ink-muted" {...p} />,
  a: ({ href = '', ...p }) =>
    /^https?:/.test(href) ? (
      <a href={href} rel="noopener noreferrer" target="_blank" className={LINK} {...p} />
    ) : (
      <a href={href} className={LINK} {...p} />
    ),
  strong: (p) => <strong className="font-semibold text-ds-ink" {...p} />,
  // remark-gfm marks task lists with class "contains-task-list": no bullet, the checkbox leads.
  ul: ({ className, ...p }) => (
    <ul
      className={dsCn(
        'mt-4 space-y-1.5 text-ds-ink-muted',
        className?.includes('contains-task-list') ? 'list-none pl-0' : 'list-disc pl-5',
        className,
      )}
      {...p}
    />
  ),
  ol: (p) => <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-ds-ink-muted" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  input: (p) => <input className="mr-2 align-middle accent-ds-primary" {...p} />,
  blockquote: (p) => <blockquote className="mt-4 border-l-4 border-ds-border-strong pl-4 text-ds-ink-muted" {...p} />,
  hr: () => <hr className="mt-8 border-ds-border" />,
  code: (p) => <code className={CODE} {...p} />,
  // A fenced block: the inline-code chip style is reset inside it; long lines scroll in the block.
  pre: (p) => (
    <pre
      className="mt-4 overflow-x-auto rounded-ds-inner border border-ds-border bg-ds-surface p-4 text-sm text-ds-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:[overflow-wrap:normal]"
      {...p}
    />
  ),
  table: (p) => (
    <div className="mt-4 overflow-x-auto rounded-ds-inner border border-ds-border bg-ds-surface">
      {/* min-width + nowrap headers: on a phone the table scrolls inside this wrapper instead of
          squeezing its columns to one character (review focus #4). */}
      <table className="w-full min-w-[480px] text-left text-sm [&_code]:whitespace-nowrap" {...p} />
    </div>
  ),
  th: (p) => <th className="whitespace-nowrap border-b border-ds-border px-4 py-2 font-semibold text-ds-ink" {...p} />,
  td: (p) => <td className="border-b border-ds-border px-4 py-2 align-top text-ds-ink-muted" {...p} />,
  Fact,
  TemplateCatalog,
  ErrorStatusTable,
  GuideLink,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
