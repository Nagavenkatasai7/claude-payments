import { RegisterForm } from '../account-forms';
import { getOnboardingTokenStore } from '@/lib/onboarding-token';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Create your account · SmartRemit' };

/**
 * Register page. Accepts an optional `?token=` (a WhatsApp onboarding deep link):
 * if it resolves (verify is read-only — register consumes it), we prefill the
 * bound phone. The token is NOT required; the WhatsApp OTP is the real possession
 * proof. We never echo the raw token into the page beyond the hidden field, and a
 * bad/expired token simply renders the empty form.
 */
export default async function AccountRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  let prefillPhone: string | undefined;
  if (token) {
    const bound = await getOnboardingTokenStore().verifyOnboardingToken(token);
    if (bound) prefillPhone = bound;
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-2xl font-bold tracking-tight">
          Smart<span className="text-primary">Remit</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Create your account</CardTitle>
          </CardHeader>
          <CardContent>
            <RegisterForm token={token} prefillPhone={prefillPhone} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
