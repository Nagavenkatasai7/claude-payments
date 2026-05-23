import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="sh-login-page">
      <div className="sh-login-card">
        <div className="sh-brand">
          <div className="sh-brand-mark">SH</div>
          SendHome
        </div>
        <h1 className="sh-login-title">Staff sign in</h1>
        <LoginForm />
      </div>
    </main>
  );
}
