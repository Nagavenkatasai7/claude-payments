'use client';

import { useState } from 'react';
import { resetStaffMfaAction } from './actions';
import { Button } from '@/components/ui/button';

// Program-Fix 17b: turn a teammate's two-step verification off (lost device).
// Two clicks: "Reset 2FA" only reveals the confirm button, so a stray click on
// a dense table row never signs someone out. The action re-checks everything
// server-side (platform admin, target exists, seed-admin guard).

export function ResetMfaForm({ username, name }: { username: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
        aria-label={`Reset two-step verification for ${name}`}
      >
        Reset 2FA
      </Button>
    );
  }
  return (
    <form action={resetStaffMfaAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="username" value={username} />
      <span className="text-xs text-muted-foreground">Turn off 2FA for {name} and sign them out?</span>
      <Button type="submit" size="sm" variant="outline" className="text-destructive">
        Confirm reset
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}
