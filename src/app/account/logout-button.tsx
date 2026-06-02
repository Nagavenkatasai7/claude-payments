'use client';

import { useActionState } from 'react';
import { logoutAction } from './actions';

export function LogoutButton() {
  // logoutAction redirects (never returns), so the state stays null; we only use
  // the pending flag to disable the button mid-submit.
  const [, action, pending] = useActionState(async () => {
    await logoutAction();
    return null;
  }, null);
  return (
    <form action={action}>
      <button type="submit" className="pay-secondary" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </form>
  );
}
