import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="sh-login-page">
      <div className="sh-login-card">
        <div className="sh-brand">
          <div className="sh-brand-mark">SR</div>
          SmartRemit
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: -6, marginBottom: 4 }}>smartremit.ai</div>
        <h1 className="sh-login-title">Staff sign in</h1>
        <LoginForm />
      </div>
    </main>
  );
}
