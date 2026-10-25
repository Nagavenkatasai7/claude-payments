import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteShell } from '@/components/site/SiteShell';

// UI redesign M4 PR-6: the public trust page in the landing look (SiteShell = the landing header
// and footer). Public and indexed since the owner's go of 2026-10-25 (Raj's website brief): the
// footer links it ("Security & compliance") and the sitemap lists it. No segment sets robots.
export const metadata: Metadata = {
  title: 'Trust & security — SmartRemit',
  description: 'How SmartRemit protects data: security practices, compliance status, sub-processors and responsible disclosure.',
};

export default function TrustLayout({ children }: { children: ReactNode }) {
  return (
    <SiteShell>
      <div className="mx-auto w-full max-w-[var(--ds-container)] px-4 py-8 sm:px-6 md:py-12">{children}</div>
    </SiteShell>
  );
}
