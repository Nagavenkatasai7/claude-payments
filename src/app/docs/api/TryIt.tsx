'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ds/button';
import { Field, Input } from '@/components/ds/field';
import type { TryItOperation } from '@/lib/docs/try-it';

// UI redesign M4 PR-5 (Task 5.3): the sandbox "Try it" form under an allowlisted operation.
// The key lives in React state only: never browser storage, never a cookie, never a URL, never
// logged. The form talks to our own proxy (POST /api/docs/try-it, same origin, so the enforced
// CSP connect-src 'self' covers it); the proxy refuses anything but a sandbox key server-side.
// Collapsed by default, so the prerendered page reads the same without JavaScript. Collapsing the
// form drops the key (and the last response); a reload drops everything.

type Result = { kind: 'ok'; upstreamStatus: number; retryAfter: string | null; body: unknown } | { kind: 'error'; message: string };

const TEXTAREA =
  'min-h-[160px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface p-3 font-mono text-[13px] leading-relaxed text-ds-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

export function TryIt({ operationId, exampleBody }: { operationId: TryItOperation; exampleBody: string | null }) {
  const [key, setKey] = useState('');
  const [id, setId] = useState('');
  const [limit, setLimit] = useState('');
  const [cursor, setCursor] = useState('');
  const [body, setBody] = useState(exampleBody ?? '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const bodyId = useId();

  const needsId = operationId === 'getTransaction';
  const listParams = operationId === 'listTransactions';
  const hasBody = exampleBody !== null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    let parsedBody: unknown = undefined;
    if (hasBody) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        setResult({ kind: 'error', message: 'The request body is not valid JSON.' });
        return;
      }
    }
    const params: Record<string, string> = {};
    if (needsId) params.id = id.trim();
    if (listParams && limit.trim()) params.limit = limit.trim();
    if (listParams && cursor.trim()) params.cursor = cursor.trim();

    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/docs/try-it', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId, key: key.trim(), params, ...(hasBody ? { body: parsedBody } : {}) }),
      });
      const data: unknown = await res.json().catch(() => null);
      const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
      if (res.ok && rec && typeof rec.upstreamStatus === 'number') {
        setResult({ kind: 'ok', upstreamStatus: rec.upstreamStatus, retryAfter: typeof rec.retryAfter === 'string' ? rec.retryAfter : null, body: rec.body });
      } else {
        const message = rec && typeof rec.error === 'string' ? rec.error : 'Try it is unavailable right now.';
        setResult({ kind: 'error', message });
      }
    } catch {
      setResult({ kind: 'error', message: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <details
      className="mt-6 rounded-ds-inner border border-ds-border bg-ds-surface"
      onToggle={(e) => {
        if (!e.currentTarget.open) {
          setKey('');
          setResult(null);
        }
      }}
    >
      <summary className="cursor-pointer px-4 py-3 text-[15px] font-semibold text-ds-ink">Try it with a sandbox key</summary>
      <form onSubmit={onSubmit} className="flex flex-col gap-4 border-t border-ds-border p-4" noValidate>
        <Field name="tryit-key" label="Sandbox API key" hint="Sandbox keys only (sr_test_…). Never paste a live key." required>
          {(f) => (
            <Input
              id={f.id}
              aria-describedby={f.describedBy}
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sr_test_…"
              required
            />
          )}
        </Field>

        {needsId ? (
          <Field name="tryit-id" label="Transaction id" required>
            {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} autoComplete="off" required />}
          </Field>
        ) : null}

        {listParams ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="tryit-limit" label="limit" hint="Optional, 1 to 100.">
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} autoComplete="off" />}
            </Field>
            <Field name="tryit-cursor" label="cursor" hint="Optional, from a previous page's next_cursor.">
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={cursor} onChange={(e) => setCursor(e.target.value)} spellCheck={false} autoComplete="off" />}
            </Field>
          </div>
        ) : null}

        {hasBody ? (
          <div className="flex flex-col">
            <label htmlFor={bodyId} className="mb-1.5 text-[14px] font-semibold text-ds-ink">
              Request body (JSON)
            </label>
            <textarea id={bodyId} className={TEXTAREA} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} autoComplete="off" />
          </div>
        ) : null}

        <div>
          <Button type="submit" variant="primary" size="md" disabled={sending || key.trim() === ''}>
            {sending ? 'Sending…' : 'Send request'}
          </Button>
        </div>

        <div aria-live="polite" className="min-w-0">
          {result === null ? (
            <p className="text-[14px] text-ds-ink-muted">{sending ? 'Sending…' : 'No response yet'}</p>
          ) : result.kind === 'error' ? (
            <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
              Error: {result.message}
            </p>
          ) : (
            <>
              <p className="text-[14px] text-ds-ink">
                Response status <code className="font-mono font-semibold">{result.upstreamStatus}</code>
                {result.retryAfter ? ` (retry after ${result.retryAfter} s)` : ''}
              </p>
              <pre
                aria-label="Response body"
                className="mt-2 max-h-[420px] overflow-auto rounded-ds-inner border border-ds-border bg-ds-tint p-3 font-mono text-[13px] leading-relaxed text-ds-ink"
              >
                <code>{result.body === null || result.body === undefined ? '(no body)' : JSON.stringify(result.body, null, 2)}</code>
              </pre>
            </>
          )}
        </div>
      </form>
    </details>
  );
}
