import { LoginForm } from '../account-forms';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { customerPortalOrigin, portalUrl } from '@/lib/customer-portal-url';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · SmartRemit' };

// One customer portal (Oct 2): SmartRemit's own customers now sign in at SmartRemit's portal with a
// WhatsApp code (a correct password here hands them over too, actions.ts handOffToPortal). The
// password form stays for customers of partners that have no portal yet.
export default async function AccountLoginPage() {
  const origin = await customerPortalOrigin(DEFAULT_PARTNER_ID);
  return (
    <main id="main" className="flex min-h-svh flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-2xl font-bold tracking-tight">
          Smart<span className="text-primary">Remit</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h1>Sign in to your account</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {origin ? (
              <p data-portal-hint className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                SmartRemit customer?{' '}
                <a className="font-medium text-primary underline-offset-4 hover:underline" href={portalUrl(origin, '/portal/login')}>
                  Sign in with a WhatsApp code
                </a>
                . Passwords are retired.
              </p>
            ) : null}
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
