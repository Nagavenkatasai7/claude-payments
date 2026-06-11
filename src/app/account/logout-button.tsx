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
      <button
        type="submit"
        className="mt-2.5 w-full cursor-pointer rounded-3xl border border-[#2a3942] bg-transparent p-3 text-[15px] font-bold text-[#8696a0] disabled:cursor-default disabled:opacity-60"
        disabled={pending}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </form>
  );
}
