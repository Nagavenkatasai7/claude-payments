import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MfaForm } from './mfa-form';
import { StaffAuthShell } from '../staff-auth-shell';
import { SMARTREMIT_ICONS } from '../../brand-icons';
import { SkipLink } from '@/components/skip-link';
import { readMfaPendingToken } from '@/lib/staff-mfa-cookie';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Two-step verification · SmartRemit', icons: SMARTREMIT_ICONS };

// Program-Fix 17b: public (like /login; the middleware matcher does not cover
// it). Without the pending cookie there is nothing to verify: back to /login.
// The action re-checks the token itself; this is only the page's shortcut.

export default async function MfaPage() {
  if (!readMfaPendingToken(await cookies())) redirect('/login');
  return (
    <>
      <SkipLink />
      <StaffAuthShell
        title="Two-step verification"
        sub="Enter the code from your authenticator app to finish signing in."
        footer={
          <Link href="/login" className="font-semibold text-ds-primary underline-offset-4 hover:underline">
            Start over
          </Link>
        }
      >
        <MfaForm />
      </StaffAuthShell>
    </>
  );
}
