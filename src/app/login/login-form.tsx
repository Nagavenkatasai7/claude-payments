'use client';

import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm() {
  const [error, formAction, pending] = useActionState(login, null);
  return (
    <form action={formAction} className="sh-form">
      <label className="sh-form-field">
        Username
        <input
          name="username"
          required
          autoComplete="username"
          className="sh-input"
        />
      </label>
      <label className="sh-form-field">
        Password
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="sh-input"
        />
      </label>
      <button type="submit" disabled={pending} className="sh-btn-primary">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="sh-form-error">{error}</p>}
    </form>
  );
}
