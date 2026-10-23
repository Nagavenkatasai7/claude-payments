import Link from 'next/link';
import { Badge, Card, PageHeader } from '@/components/ds';
import { guidesFor, type Guide } from '@/content/docs/registry';

// The docs home: one group per audience, one card per guide from the registry
// (src/content/docs/registry.ts). Static: prerendered at build, no data reads.
const CARD = 'h-full p-5 transition-colors hover:border-ds-border-strong sm:p-6';

function GuideCard({ href, title, summary, comingSoon }: { href: string; title: string; summary: string; comingSoon?: boolean }) {
  return (
    <Card className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[17px] font-semibold text-ds-ink">
          <Link className="hover:text-ds-primary" href={href}>
            {title}
          </Link>
        </h3>
        {comingSoon ? <Badge tone="warning">Coming soon</Badge> : null}
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{summary}</p>
    </Card>
  );
}

function GuideCards({ guides }: { guides: readonly Guide[] }) {
  return (
    <>
      {guides.map((g) => (
        <li key={g.slug} className="min-w-0">
          <GuideCard href={`/docs/${g.slug}`} title={g.title} summary={g.summary} comingSoon={g.status === 'coming-soon'} />
        </li>
      ))}
    </>
  );
}

export default function DocsIndexPage() {
  return (
    <div>
      <PageHeader
        title="SmartRemit docs"
        sub="Guides for SmartRemit customers who use AI apps, and for partners who run SmartRemit with their licence."
      />
      <section aria-labelledby="docs-customers" className="mt-8">
        <h2 id="docs-customers" className="text-[13px] font-bold uppercase tracking-[0.1em] text-ds-ink-muted">
          For customers
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          <GuideCards guides={guidesFor('customer')} />
        </ul>
      </section>
      <section aria-labelledby="docs-partners" className="mt-10">
        <h2 id="docs-partners" className="text-[13px] font-bold uppercase tracking-[0.1em] text-ds-ink-muted">
          For partners
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          <li className="min-w-0">
            <GuideCard
              href="/docs/api"
              title="API reference"
              summary="Every Partner API operation with its scope, sandbox availability, examples and status codes, generated from the OpenAPI description."
            />
          </li>
          <GuideCards guides={guidesFor('partner')} />
        </ul>
      </section>
    </div>
  );
}
