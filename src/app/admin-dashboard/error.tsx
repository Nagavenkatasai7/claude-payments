'use client'; // Error boundaries must be Client Components (error.md:20-31).

import Link from 'next/link';
import { Button } from '@/components/ui/button';

// The staff error boundary (Program-Fix 41). It replaces a dashboard PAGE, and
// pages render `<Sidebar/><main className="sh-main">` as the two children of
// the layout grid (./layout.tsx), so a lone <main> would drop into the 240px
// sidebar column at ≥1025px: col-start-2 keeps it in the page column. The
// TopBar and the mobile drawer still come from the layout. It does NOT catch a
// throw from ./layout.tsx itself (error.md:96): that reaches the neutral root
// boundary (../error.tsx). The scaffold classes are the e2e hooks: keep them.
// Only error.digest is shown, never error.message (error.md:108-115).

export default function AdminDashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main id="main" className="sh-main min-[1025px]:col-start-2">
      <div className="sh-page-head">
        <div>
          <h1 className="sh-page-title">Something went wrong</h1>
          <p className="sh-page-sub">
            {error.digest ? (
              <>
                Reference: <span className="font-mono">{error.digest}</span>
              </>
            ) : (
              'This page failed to load.'
            )}
          </p>
        </div>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        This page failed to load. Try again, or go back to the dashboard. If it keeps failing,
        share the reference above with engineering.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/admin-dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
