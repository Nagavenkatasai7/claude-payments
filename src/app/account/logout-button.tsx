'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
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
      <Button type="submit" variant="outline" className="w-full" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
    </form>
  );
}
