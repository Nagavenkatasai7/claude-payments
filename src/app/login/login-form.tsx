'use client';

import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm() {
  const [error, formAction, pending] = useActionState(login, null);
  return (
    <form action={formAction} className="login-form">
      <label>
        Username
        <input name="username" required autoComplete="username" />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="err">{error}</p>}
    </form>
  );
}
