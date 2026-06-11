'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { issueApiKeyAction } from './actions';

// One-time API-key reveal. The plaintext is returned by the server action and
// shown ONCE in component state — never persisted, never re-fetchable. Closing
// the banner discards it.
export function IssueKeyButton({ partnerId }: { partnerId: string }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onIssue() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await issueApiKeyAction(partnerId);
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
      <Button
        type="button"
        onClick={onIssue}
        disabled={pending}
      >
        {pending ? 'Issuing…' : 'Issue new API key'}
      </Button>
    </div>
  );
}
