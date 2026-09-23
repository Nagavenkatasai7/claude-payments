// csp — the one Content-Security-Policy builder (Program-Fix 47).
//
// next.config.ts imports this by RELATIVE path to build the enforced policy on
// every route, so this file must stay import-free (no `@/` alias, no Node APIs).
// The middleware builds the same policy with a per-request nonce and sends it
// as REPORT-ONLY on the dynamic trees (PR1); PR2 enforces it there.
//
// Sources, node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md:
//   :42  'unsafe-eval' is needed only in development ("Neither React nor
//        Next.js use `eval` in production by default").
//   :52  nonce policy shape: 'self' 'nonce-<n>' 'strict-dynamic'.

export interface CspOptions {
  /** Per-request nonce. When set, script-src trusts it instead of 'unsafe-inline'. */
  nonce?: string;
  /** `process.env.NODE_ENV === 'development'` — adds 'unsafe-eval' for React dev stacks. */
  isDev: boolean;
}

export function buildCsp({ nonce, isDev }: CspOptions): string {
  const script = nonce
    ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
    : ["'self'", "'unsafe-inline'"];
  if (isDev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // Kept as-is: a style nonce would block inline style= attributes.
    "style-src 'self' 'unsafe-inline'",
    // https: — partner logos may be any https URL (sanitizeLogoValue, src/lib/logo.ts).
    "img-src 'self' data: blob: https:",
    // Video for the /about explainer: same-origin /public today; the Vercel Blob
    // host is pre-allowed so a large file can move there with no CSP change.
    "media-src 'self' https://*.public.blob.vercel-storage.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * A fresh, unpredictable nonce: base64 of a random UUID. `btoa` and
 * `crypto.randomUUID` exist on both the Node and Edge runtimes (the guide's
 * `Buffer` does not exist on Edge). 36 ASCII chars → 48 base64 chars, which
 * Next's extractor accepts (`/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/`,
 * next/dist/server/app-render/get-script-nonce-from-header.js).
 */
export function makeNonce(): string {
  return btoa(crypto.randomUUID());
}
