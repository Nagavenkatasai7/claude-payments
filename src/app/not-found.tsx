import type { Metadata } from 'next';

// The root 404 (Program-Fix 41). Next renders it for every unmatched URL and
// for any notFound() without a closer not-found file (node_modules/next/dist/
// docs/01-app/03-api-reference/03-file-conventions/not-found.md:133), which
// includes the white-label /pay/** tree and the staff dashboard. So it is
// BRAND-NEUTRAL: no SmartRemit name or mark, no link to /, neutral colours
// only. The metadata title replaces the root layout's "SmartRemit" tab title
// (the not-found module's metadata is collected for the error convention:
// next/dist/lib/metadata/resolve-metadata.js, collectMetadata).
export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-16 text-center text-foreground"
    >
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">Check the link you were sent.</p>
    </main>
  );
}
