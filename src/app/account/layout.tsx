import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { SkipLink } from '@/components/skip-link';
import { env } from '@/lib/env';
import { t } from '@/lib/i18n';
import { passwordSunsetLabel } from '@/lib/password-sunset';
import { PasswordSunsetBanner } from './password-sunset-banner';

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
// M2-14 Task 14.2: while CUSTOMER_PASSWORD_SUNSET is a valid date, every
// /account page carries the dismissible password-sunset notice. The env is read
// at request time (connection(): node_modules/next/dist/docs/01-app/02-guides/
// self-hosting.md:52-55), so setting or clearing it needs no rebuild.
export default async function AccountLayout({ children }: { children: ReactNode }) {
  await connection();
  const sunset = passwordSunsetLabel(env.customerPasswordSunset);
  return (
    <div className="account-brand">
      <SkipLink />
      {sunset ? (
        <PasswordSunsetBanner
          message={t('portal.legacy.banner', { date: sunset })}
          dismissLabel={t('portal.legacy.bannerDismiss')}
        />
      ) : null}
      {children}
    </div>
  );
}
