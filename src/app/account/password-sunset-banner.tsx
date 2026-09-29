'use client';

import { useSyncExternalStore } from 'react';

// UI redesign M2-14 Task 14.2: the legacy password-sign-in notice on apex
// /account. Dismissed per browser session (sessionStorage; every access is
// guarded: storage can be blocked or throw). Deliberately no heading, no
// <aside> and no role="alert": the dashboard smoke keys on heading roles and
// `aside.sh-sidebar`, and this is a notice, not an interruption.
const KEY = 'sr.account.passwordSunsetDismissed';
const listeners = new Set<() => void>();
// Set on dismiss so a blocked sessionStorage still hides the notice for this page view.
let memo = false;

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function dismiss(): void {
  try {
    window.sessionStorage.setItem(KEY, '1');
  } catch {
    /* storage blocked: the banner still hides for this page view */
  }
  memo = true;
  listeners.forEach((l) => l());
}


export function PasswordSunsetBanner({ message, dismissLabel }: { message: string; dismissLabel: string }) {
  // Server snapshot: not dismissed (the server can't see sessionStorage).
  const dismissed = useSyncExternalStore(
    subscribe,
    () => memo || readDismissed(),
    () => false,
  );
  if (dismissed) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
      <p className="leading-snug">{message}</p>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded px-2 text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {dismissLabel}
      </button>
    </div>
  );
}
