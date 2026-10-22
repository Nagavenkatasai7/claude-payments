import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteShell } from '@/components/site/SiteShell';
import { DocsNav } from './DocsNav';

// UI redesign M4: the docs in the landing look (SiteShell = the landing header and footer).
// The site header and footer link /docs, and search engines may index it (the sitemap lists
// every guide). /docs-next/* redirects here permanently (next.config.ts).
export const metadata: Metadata = {
  title: { default: 'SmartRemit docs', template: '%s — SmartRemit docs' },
  description: 'SmartRemit docs: use SmartRemit in AI apps, and integrate the Partner API (keys, sandbox, webhooks, WhatsApp setup and go-live).',
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <SiteShell>
      <div className="mx-auto grid w-full max-w-[var(--ds-container)] gap-6 px-4 py-8 sm:px-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10 md:py-12">
        <DocsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </SiteShell>
  );
}
