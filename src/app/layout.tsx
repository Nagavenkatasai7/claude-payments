import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'SmartRemit',
  description: 'Send money across borders via WhatsApp',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
