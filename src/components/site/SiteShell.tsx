import type { ReactNode } from 'react';
import { SkipLink } from '@/components/skip-link';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

// The shared public-site frame (UI redesign M4): the landing's root look (Inter via the root
// layout's --font-inter, ground colour, ink, line height, focus ring) around SiteHeader, the
// page and SiteFooter. <main id="main"> is the skip link's target. The landing's mobile sticky
// WhatsApp CTA is a landing conversion element and is left out here (plan default Q2).
const ROOT =
  'min-h-svh overflow-x-clip bg-ds-ground font-sans leading-[1.6] text-ds-ink antialiased ' +
  '[&_:focus-visible]:rounded-ds-focus [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[3px] [&_:focus-visible]:outline-ds-focus-ring';

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className={ROOT}>
      <SkipLink />
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </div>
  );
}
