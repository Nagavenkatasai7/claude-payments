import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="card">
      <div className="brand">SendHome</div>
      <h1>Staff sign in</h1>
      <LoginForm />
    </main>
  );
}
