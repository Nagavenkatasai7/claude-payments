import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// UI redesign M4 PR-5 (Task 5.3): the "Try it" client form. UI is not unit-tested (CLAUDE.md), so
// this pins the SOURCE: the key lives in React state only (no browser storage, no cookie), nothing
// is logged, nothing is injected as HTML, the form talks to nothing but our own proxy, and the
// island renders only for allowlisted sandbox operations.

const FILE = 'src/app/docs-next/api/TryIt.tsx';
const src = () => readFileSync(FILE, 'utf8');

describe('TryIt.tsx (client form) source guard', () => {
  it('exists and is a client component', () => {
    expect(existsSync(FILE)).toBe(true);
    expect(src().trimStart().startsWith("'use client'")).toBe(true);
  });

  it.each(['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.', 'dangerouslySetInnerHTML', 'http', 'navigator.sendBeacon', 'XMLHttpRequest', 'WebSocket', 'window.open', 'location.'])(
    'contains no %s',
    (needle) => {
      expect(src().includes(needle)).toBe(false);
    },
  );

  it("its only fetch( targets the literal '/api/docs/try-it' with POST + a JSON content type", () => {
    const calls = [...src().matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    expect(calls).toEqual(["'/api/docs/try-it'"]);
    expect(src()).toMatch(/method:\s*'POST'/);
    expect(src()).toMatch(/'content-type':\s*'application\/json'/);
  });

  it('the key input is a labelled password field that the browser will not autofill or spell-check', () => {
    const s = src();
    expect(s).toMatch(/type="password"/);
    // Password managers ignore autocomplete="off" on a password field; new-password plus the
    // manager opt-outs keeps the key from being offered for saving (security review LOW 1).
    expect(s).toMatch(/autoComplete="new-password"/);
    expect(s).toContain('data-1p-ignore');
    expect(s).toContain('data-lpignore="true"');
    expect(s).toMatch(/spellCheck=\{false\}/);
    expect(s).toContain('Sandbox keys only (sr_test_…). Never paste a live key.');
  });

  it('the key is cleared when the form is collapsed and never put in a URL', () => {
    // A state update during unmount is discarded by React, so an unmount cleanup would be a false
    // promise (security review LOW 2). Collapsing the <details> is the real "done" signal.
    const s = src();
    expect(s).toMatch(/onToggle=\{[^}]*if \(!e\.currentTarget\.open\) \{?\s*setKey\(''\)/);
    expect(s).not.toMatch(/useEffect/);
    expect(s).not.toMatch(/URLSearchParams|searchParams|encodeURIComponent\(\s*key/);
  });

  it('renders the loading, error and empty states as text', () => {
    const s = src();
    for (const t of ['Sending…', 'No response yet']) expect(s).toContain(t);
    expect(s).toMatch(/role="alert"/);
  });

  it('Operation.tsx renders the island only for allowlisted sandbox operations', () => {
    const op = readFileSync('src/app/docs-next/api/Operation.tsx', 'utf8');
    expect(op).toMatch(/import \{ TryIt \} from '\.\/TryIt'/);
    expect(op).toMatch(/op\.sandbox && isTryItOperation\(op\.operationId\)/);
  });
});
