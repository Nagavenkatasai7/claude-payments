import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SMARTREMIT_ICONS } from '../brand-icons';

// Metadata-only, pass-through layout: the customer portal is SmartRemit-owned,
// so its whole subtree carries the SmartRemit.ai tab icon (see brand-icons.ts
// for why icons are per-route, not app/icon.png). Renders nothing of its own.
export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
