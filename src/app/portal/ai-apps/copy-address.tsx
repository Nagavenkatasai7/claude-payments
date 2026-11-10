'use client';

import { useState } from 'react';
import { Button } from '@/components/ds';

/**
 * Copy the connector address (TGFL custom host, design §5.4). Follows the partner payment-links copy
 * button: the address is on screen next to it, so a refused clipboard still works by hand. Every
 * text comes from props (the server page translates), so this client island loads no catalogue.
 */
export function CopyAddress({ text, label, copiedLabel, ariaLabel }: { text: string; label: string; copiedLabel: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={ariaLabel}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* the address is on screen; it can be copied by hand */
          }
        }}
      >
        {label}
      </Button>
      <span aria-live="polite" className="text-[13px] text-ds-ink-muted">
        {copied ? copiedLabel : null}
      </span>
    </span>
  );
}
