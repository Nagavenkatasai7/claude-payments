import { LoginForm } from '../account-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · SmartRemit' };

export default function AccountLoginPage() {
  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Sign in to your account</h1>
        <LoginForm />
      </div>
    </main>
  );
}
