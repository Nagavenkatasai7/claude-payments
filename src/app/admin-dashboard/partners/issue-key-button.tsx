'use client';

import { useState, useTransition } from 'react';
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
    <div style={{ marginTop: 12 }}>
      {issued && (
        <div
          style={{
            border: '1px solid var(--sh-border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            background: 'var(--sh-surface-2, #f6f8fa)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Copy this key now — it will never be shown again.
          </div>
          <code
            style={{
              display: 'block',
              wordBreak: 'break-all',
              padding: '8px 10px',
              background: 'var(--sh-surface, #fff)',
              border: '1px solid var(--sh-border)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {issued}
          </code>
          <button
            type="button"
            className="sh-mini-btn"
            style={{ marginTop: 8 }}
            onClick={() => setIssued(null)}
          >
            I&apos;ve copied it
          </button>
        </div>
      )}
      {error && (
        <p style={{ color: 'var(--sh-danger, #c0392b)', marginBottom: 8 }}>{error}</p>
      )}
      <button
        type="button"
        className="sh-btn-primary"
        onClick={onIssue}
        disabled={pending}
      >
        {pending ? 'Issuing…' : 'Issue new API key'}
      </button>
    </div>
  );
}
