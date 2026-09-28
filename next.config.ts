import type { NextConfig } from 'next';
import { resolve } from 'node:path';
import createMDX from '@next/mdx';
import { buildCsp } from './src/lib/csp';

// Security headers on EVERY response (Stage 3; CSP enforced as of Stage 5e —
// it ran report-only through the design migration with zero violations
// beyond the known inline allowances).
const securityHeaders = [
  // 2 years, ready for preload submission. Vercel already redirects http→https.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Belt (header) + braces (CSP frame-ancestors): a payment page must never be framed.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  {
    key: 'Content-Security-Policy',
    // Built by src/lib/csp.ts (imported by relative path: next.config is loaded
    // outside the `@/` alias). Program-Fix 47: the same policy as before plus
    // https: images (partner logos) and object-src 'none'. PR2: 'unsafe-eval'
    // only under `next dev` (NODE_ENV=development); `next build`/`next start`
    // default NODE_ENV to production (node_modules/next/dist/bin/next:65,84),
    // so production ships none. 'unsafe-inline' remains; a nonce-based
    // script-src is the tracked follow-up.
    value: buildCsp({ isDev: process.env.NODE_ENV === 'development' }),
  },
];

const nextConfig: NextConfig = {
  // No `x-powered-by: Next.js` on any response: it only advertises the stack
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/
  // 01-next-config-js/poweredByHeader.md).
  poweredByHeader: false,
  // nodemailer is a Node CommonJS lib with dynamic/optional requires — keep it
  // external so Turbopack doesn't bundle it into the server build (it's only ever
  // imported server-side, in src/lib/email.ts → the /api/worker route).
  serverExternalPackages: ['nodemailer'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async redirects() {
    // The staff dashboard moved from /dashboard to /admin-dashboard so that `/`
    // can host the public SmartRemit landing page. Keep a permanent redirect for
    // one release cycle so bookmarked URLs and — critically — in-flight KYC links
    // already shared with customers (/dashboard/customers/<phone>) don't 404.
    return [
      { source: '/dashboard', destination: '/admin-dashboard', permanent: true },
      {
        source: '/dashboard/:path*',
        destination: '/admin-dashboard/:path*',
        permanent: true,
      },
    ];
  },
};

// Partner guides (UI redesign M4): src/content/docs/*.mdx are IMPORTED by the /docs-next
// pages and compiled at build to server components (no client JS, no inline script, no CSP
// change). The wrap only adds the .mdx loader (node_modules/@next/mdx/index.js): no
// pageExtensions change, so no .mdx file becomes a route. remark-gfm (pipe tables, task
// lists) is passed BY NAME for Turbopack (node_modules/next/dist/docs/01-app/02-guides/
// mdx.md "Using Plugins with Turbopack"). Pinned by tests/next-config-headers.test.ts.
// The second plugin is the local guard that refuses MDX expressions, ESM, expression attributes
// and unknown components, so a guide can never evaluate code (e.g. an env var) at build time
// (src/lib/mdx/remark-no-mdx-expressions.mjs). Passed as an absolute path string: the loader
// require.resolve()s plugin strings from the .mdx file's directory, and `next build` runs from
// the project root.
const withMDX = createMDX({
  options: { remarkPlugins: ['remark-gfm', resolve('src/lib/mdx/remark-no-mdx-expressions.mjs')] },
});

export default withMDX(nextConfig);
