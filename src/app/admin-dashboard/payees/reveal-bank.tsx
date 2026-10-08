'use client';

import { useState } from 'react';
import { revealPayeeBankAction } from './actions';

/**
 * The payee's bank details stay masked (last 4) until a platform admin opens
 * this; opening it calls the AUDITED reveal (a pii.reveal row) and shows the
 * decrypted values in place. Nothing is kept beyond this component.
 */
export function RevealBank({ payeeId, last4 }: { payeeId: string; last4: string }) {
  const [full, setFull] = useState<{ accountHolder: string; payoutDestination: string } | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <details
      className="group text-xs text-muted-foreground"
      onToggle={async (e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || full || failed) return;
        const r = await revealPayeeBankAction(payeeId);
        if ('accountHolder' in r) setFull(r);
        else setFailed(true);
      }}
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden after:font-semibold after:text-primary after:content-['_·_reveal'] group-open:after:content-['_·_hide']">
        Account ****{last4}
      </summary>
      <span className="mt-0.5 block tabular-nums text-foreground">
        {failed ? 'Reveal failed' : full ? `${full.accountHolder} · ${full.payoutDestination}` : '…'}
      </span>
    </details>
  );
}
