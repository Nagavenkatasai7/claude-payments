import { ResetForm } from '../account-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Reset your password · SmartRemit' };

export default function AccountResetPage() {
  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Reset your password</h1>
        <ResetForm />
      </div>
    </main>
  );
}
