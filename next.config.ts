import type { NextConfig } from 'next';

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
    value: [
      "default-src 'self'",
      // 'unsafe-inline'/'unsafe-eval' remain for Next's inline runtime + React
      // hydration. The ENFORCED wins here are the network/framing axes:
      // default/connect/img/font pinned to self, framing+base+form locked.
      // Nonce-based script-src is the follow-up hardening item.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      // Video for the /about explainer: same-origin /public today; the Vercel Blob
      // host is pre-allowed so a large file can move there with no CSP change.
      "media-src 'self' https://*.public.blob.vercel-storage.com",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
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

export default nextConfig;
