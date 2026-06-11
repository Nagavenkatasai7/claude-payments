import { RegisterForm } from '../account-forms';
import { getOnboardingTokenStore } from '@/lib/onboarding-token';

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
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Create your account</h1>
        <RegisterForm token={token} prefillPhone={prefillPhone} />
      </div>
    </main>
  );
}
