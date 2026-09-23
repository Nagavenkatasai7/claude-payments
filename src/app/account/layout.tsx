import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { SkipLink } from '@/components/skip-link';

// The customer portal is SmartRemit-owned, so its whole subtree carries the
// SmartRemit.ai tab icon (see brand-icons.ts for why icons are per-route, not
// app/icon.png).
export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

// Program-Fix 41 (ui-06): `.account-brand` (tailwind.css) re-points the shadcn
// tokens at the landing's light brand for /account/** only, so bg-primary,
// text-primary, focus rings and the muted ground turn SmartRemit blue here
// while the staff /login and the dashboard keep the shadcn indigo. It is
// `display: contents`, so the wrapper adds no box and changes no layout. The
// skip link targets id="main": the auth pages' <main> and the signed-in
// AccountShell's <main> both carry it.
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="account-brand">
      <SkipLink />
      {children}
    </div>
  );
}
