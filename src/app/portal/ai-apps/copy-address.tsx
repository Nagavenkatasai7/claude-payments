'use client';

import { useState } from 'react';
import { Button } from '@/components/ds';

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Write `text` to the clipboard. 'failed' when there is no clipboard (an insecure context, an older
 * WebView) or it refuses; the caller then says so, and the address on screen can be copied by hand.
 */
export async function copyText(clipboard: Pick<Clipboard, 'writeText'> | undefined, text: string): Promise<'copied' | 'failed'> {
  try {
    if (!clipboard) return 'failed';
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Copy the connector address (TGFL custom host, design §5.4). Follows the partner payment-links copy
 * button, but a refused clipboard is announced (failedLabel) instead of a silent click: the address
 * is on screen next to it, so it still works by hand. Every text comes from props (the server page
 * translates), so this client island loads no catalogue.
 */
export function CopyAddress({
  text,
  label,
  copiedLabel,
  failedLabel,
  ariaLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  ariaLabel: string;
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={ariaLabel}
        onClick={async () => {
          const result = await copyText(typeof navigator === 'undefined' ? undefined : navigator.clipboard, text);
          setStatus(result);
          if (result === 'copied') setTimeout(() => setStatus('idle'), 2000);
        }}
      >
        {label}
      </Button>
      <span aria-live="polite" className="text-[13px] text-ds-ink-muted">
        {status === 'copied' ? copiedLabel : status === 'failed' ? failedLabel : null}
      </span>
    </span>
  );
}
