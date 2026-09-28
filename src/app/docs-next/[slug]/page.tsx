import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, PageHeader } from '@/components/ds';
import { GUIDES, guideBySlug, guideStaticParams } from '@/content/docs/registry';

// One prerendered page per registered guide (node_modules/next/dist/docs/01-app/02-guides/
// mdx.md "Using dynamic imports"). Any other slug is a 404 (dynamicParams = false), and the
// .mdx import only ever sees a registry-validated slug. The guide body starts at h2; the
// PageHeader title is the page's single h1.
export const dynamicParams = false;

export function generateStaticParams() {
  return guideStaticParams();
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  return guide ? { title: guide.title, description: guide.summary } : {};
}

export default async function GuidePage({ params }: Params) {
  const guide = guideBySlug((await params).slug);
  if (!guide) notFound();
  const { default: Guide } = await import(`@/content/docs/${guide.slug}.mdx`);
  const i = GUIDES.findIndex((g) => g.slug === guide.slug);
  const prev = GUIDES[i - 1];
  const next = GUIDES[i + 1];
  return (
    <article className="break-words">
      <PageHeader
        title={guide.title}
        sub={guide.summary}
        actions={guide.status === 'coming-soon' ? <Badge tone="warning">Coming soon</Badge> : undefined}
      />
      <div className="max-w-[72ch]">
        <Guide />
      </div>
      <nav aria-label="More guides" className="mt-12 flex flex-wrap justify-between gap-4 border-t border-ds-border pt-6 text-[15px]">
        {prev ? (
          <Link className="font-semibold text-ds-primary hover:underline" href={`/docs-next/${prev.slug}`}>
            ← {prev.title}
          </Link>
        ) : (
          <Link className="font-semibold text-ds-primary hover:underline" href="/docs-next">
            ← All guides
          </Link>
        )}
        {next ? (
          <Link className="font-semibold text-ds-primary hover:underline" href={`/docs-next/${next.slug}`}>
            {next.title} →
          </Link>
        ) : null}
      </nav>
    </article>
  );
}
