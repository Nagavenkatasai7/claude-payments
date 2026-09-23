'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { issueApiKeyAction } from './actions';

// One-time API-key reveal. The plaintext is returned by the server action and
// shown ONCE in component state — never persisted, never re-fetchable. Closing
// the banner discards it.
//
// Fix 44 P2: the mode select issues a Live key (default) or a Test (sandbox)
// key. A test key's transfers settle only on the mock rail and never message a
// customer; the server action re-validates the mode (strict allowlist).
export function IssueKeyButton({ partnerId }: { partnerId: string }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [mode, setMode] = useState<'live' | 'test'>('live');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onIssue() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await issueApiKeyAction(partnerId, mode);
        setIssued(r.plaintext);
      } catch {
        setError('Could not issue a key. You may not have permission.');
      }
    });
  }

  return (
    <div className="mt-3">
      {issued && (
        <div className="mb-3 rounded-lg border border-border bg-muted/50 p-3">
          <div className="mb-1.5 text-sm font-semibold">
            Copy this key now — it will never be shown again.
          </div>
          <code className="block break-all rounded-md border border-border bg-card px-2.5 py-2 text-[13px]">
            {issued}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setIssued(null)}
          >
            I&apos;ve copied it
          </Button>
        </div>
      )}
      {error && (
        <p className="mb-2 text-sm text-destructive">{error}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`key-mode-${partnerId}`}>Key mode</label>
        <select
          id={`key-mode-${partnerId}`}
          value={mode}
          onChange={(e) => setMode(e.target.value === 'test' ? 'test' : 'live')}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm"
        >
          <option value="live">Live</option>
          <option value="test">Test (sandbox: mock rail, no customer messages)</option>
        </select>
        <Button
          type="button"
          onClick={onIssue}
          disabled={pending}
        >
          {pending ? 'Issuing…' : 'Issue new API key'}
        </Button>
      </div>
    </div>
  );
}
