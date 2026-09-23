'use client'; // Error boundaries must be Client Components (error.md:20-31).

// The root error boundary (Program-Fix 41). It catches a throw in any page
// below the root layout, including the white-label /pay/** pages, so it is
// BRAND-NEUTRAL: no SmartRemit name or mark, no link to /, neutral colours.
// It never renders error.message; only error.digest, the hash that matches the
// server log (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/error.md:108-115). `retry` re-fetches and re-renders the
// segment; it is the stable prop as of Next 16.3 (error.md:117-121, :331).

export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
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
  );
}
