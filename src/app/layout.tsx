import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'SendHome',
  description: 'Send money to family in India via WhatsApp',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
