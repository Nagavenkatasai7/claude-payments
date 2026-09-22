import './tailwind.css'; // THE stylesheet pipeline (Stage 5e): preflight + legacy theme layers + utilities
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';

// Self-hosted Inter for the login + admin-dashboard (sh-* theme). Exposed as a CSS
// variable that --sh-font-sans consumes (globals.css). The landing (.lp) and pay
// (.payapp) scopes set their own font-family, so this doesn't disturb them.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

// metadataBase makes the page-level share images (openGraph/twitter `images`
// on / and /about) absolute https://smartremit.ai URLs in production, which
// link-preview crawlers need (generate-metadata.md "metadataBase"). On Vercel
// previews Next uses the preview URL, and localhost in dev, for social images
// (next/dist/lib/metadata/resolvers/resolve-url.js,
// getSocialImageMetadataBaseFallback). The default title and description stay
// neutral: routes without their own metadata (the white-label /pay/** pages)
// inherit them. There are no root icons: SmartRemit-owned routes set theirs
// (./brand-icons.ts) so the white-label pay page never shows the mark.
export const metadata: Metadata = {
  metadataBase: new URL('https://smartremit.ai'),
  title: 'SmartRemit',
  description: 'Send money across borders via WhatsApp',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Enable env(safe-area-inset-*) so notched-phone surfaces (the mobile drawer,
  // the landing sticky CTA) can pad around the notch / home indicator.
  viewportFit: 'cover' as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
