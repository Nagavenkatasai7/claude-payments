'use client'; // Error boundaries must be Client Components (error.md:20-31).

// The last-resort boundary (Program-Fix 41): it replaces the ROOT LAYOUT when
// the layout itself throws, so it must render its own <html> and <body> and
// load its own styles (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/error.md:163-165, :180-186). A broken one would blank
// every such error, including on the money page. Client Components cannot
// export metadata, so the tab title is a React <title> (error.md:167).
//
// BRAND-NEUTRAL (it can render under the white-label /pay/** pages): no
// SmartRemit name or mark, no link to /. Only error.digest is shown, never
// error.message (error.md:108-115).
import './tailwind.css';

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <title>Something went wrong</title>
        <main
          id="main"
          className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-16 text-center text-foreground"
        >
          <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-3 max-w-sm text-sm text-muted-foreground">
            This page could not be loaded. Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-foreground px-5 text-sm font-medium text-background hover:bg-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Try again
          </button>
          {error.digest ? (
            <p className="mt-6 text-xs text-muted-foreground">
              Reference: <span className="font-mono">{error.digest}</span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
