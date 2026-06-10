import './tailwind.css'; // THE stylesheet pipeline (Stage 5e): preflight + legacy theme layers + utilities
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

export const metadata = {
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
