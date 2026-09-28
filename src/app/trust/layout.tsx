import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteShell } from '@/components/site/SiteShell';

// UI redesign M4 PR-6: the public trust page in the landing look (SiteShell = the landing header
// and footer). An UNLINKED preview until the post-demo swap (SPEC §7): noindex is set here ONLY,
// and no child segment sets robots (nested metadata would overwrite it:
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md).
export const metadata: Metadata = {
  title: 'Trust & security — SmartRemit',
  description: 'How SmartRemit protects data: security practices, compliance status, sub-processors and responsible disclosure.',
  robots: { index: false, follow: false },
};

export default function TrustLayout({ children }: { children: ReactNode }) {
  return (
    <SiteShell>
      <div className="mx-auto w-full max-w-[var(--ds-container)] px-4 py-8 sm:px-6 md:py-12">{children}</div>
    </SiteShell>
  );
}
