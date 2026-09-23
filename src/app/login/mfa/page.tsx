import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MfaForm } from './mfa-form';
import { SMARTREMIT_ICONS } from '../../brand-icons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkipLink } from '@/components/skip-link';
import { readMfaPendingToken } from '@/lib/staff-mfa-cookie';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

// Program-Fix 17b: public (like /login; the middleware matcher does not cover
// it). Without the pending cookie there is nothing to verify: back to /login.
// The action re-checks the token itself; this is only the page's shortcut.

export default async function MfaPage() {
  if (!readMfaPendingToken(await cookies())) redirect('/login');
  return (
    <>
      <SkipLink />
      <main
        id="main"
        className="flex min-h-screen items-center justify-center bg-background px-4 font-sans text-foreground antialiased"
      >
        <Card className="w-full max-w-sm">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                SR
              </span>
              SmartRemit
            </div>
            <p className="text-xs text-muted-foreground">smartremit.ai</p>
            <CardTitle className="pt-2 text-xl">
              <h1>Two-step verification</h1>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <MfaForm />
            <p className="text-center text-xs text-muted-foreground">
              <Link href="/login" className="underline underline-offset-2">
                Start over
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
