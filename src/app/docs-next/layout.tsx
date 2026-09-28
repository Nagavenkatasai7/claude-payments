import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteShell } from '@/components/site/SiteShell';
import { DocsNav } from './DocsNav';

// UI redesign M4: the partner docs in the landing look (SiteShell = the landing header and
// footer). An UNLINKED preview until the post-demo swap (SPEC §7): noindex is set here ONLY,
// and no child segment sets robots (nested metadata would overwrite it:
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md).
export const metadata: Metadata = {
  title: { default: 'Partner docs — SmartRemit', template: '%s — SmartRemit docs' },
  description: 'Integrate the SmartRemit Partner API: keys, sandbox, webhooks, WhatsApp setup and go-live.',
  robots: { index: false, follow: false },
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
