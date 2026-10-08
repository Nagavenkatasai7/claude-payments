'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';

/** Copy a payment link to the clipboard. The link is shown next to it, so a refused clipboard still works by hand. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          /* the link is on screen; it can be copied by hand */
        }
      }}
    >
      {copied ? t('partner.paymentLinks.copied') : t('partner.paymentLinks.copy')}
    </Button>
  );
}
