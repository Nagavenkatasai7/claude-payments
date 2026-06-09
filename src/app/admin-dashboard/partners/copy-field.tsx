'use client';

import { useState } from 'react';

// A labeled, read-only value with one-click copy — used by the Integration card
// so a partner can grab their webhook URLs / endpoints without typos.
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (http / permissions) — the value is selectable text.
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="sh-field-label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code
          style={{
            flex: 1,
            display: 'block',
            padding: '8px 10px',
            background: 'var(--sh-surface-2, #f6f8fa)',
            border: '1px solid var(--sh-border)',
            borderRadius: 6,
            fontSize: 12.5,
            wordBreak: 'break-all',
            userSelect: 'all',
          }}
        >
          {value}
        </code>
        <button type="button" className="sh-mini-btn" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
