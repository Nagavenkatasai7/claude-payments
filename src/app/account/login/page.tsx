import { LoginForm } from '../account-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · SmartRemit' };

export default function AccountLoginPage() {
  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Sign in to your account</h1>
        <LoginForm />
      </div>
    </main>
  );
}
