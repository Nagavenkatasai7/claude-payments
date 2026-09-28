import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ds';
import { GUIDES } from '@/content/docs/registry';

// The docs index: one card per guide from the registry (src/content/docs/registry.ts).
// Static: prerendered at build, no data reads.
export default function DocsIndexPage() {
  return (
    <div>
      <PageHeader
        title="Partner documentation"
        sub="Everything you need to run SmartRemit under your own brand: API keys, the sandbox, webhooks, your WhatsApp number and go-live."
      />
      {GUIDES.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No guides yet" body="The partner guides are being written. Check back soon." />
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {GUIDES.map((g) => (
            <li key={g.slug} className="min-w-0">
              <Card className="h-full p-5 transition-colors hover:border-ds-border-strong sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[17px] font-semibold text-ds-ink">
                    <Link className="hover:text-ds-primary" href={`/docs-next/${g.slug}`}>
                      {g.title}
                    </Link>
                  </h2>
                  {g.status === 'coming-soon' ? <Badge tone="warning">Coming soon</Badge> : null}
                </div>
                <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{g.summary}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
