'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

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
    <div className="mb-2.5">
      <div className="mb-1 text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2">
        <code className="block flex-1 select-all break-all rounded-md border border-border bg-muted/50 px-2.5 py-2 text-xs">
          {value}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied ✓' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
