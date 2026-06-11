'use client';

import { useState } from 'react';
import type { PayoutMethod } from '@/lib/types';
import { revealDestinationAction } from './actions';

/**
 * Staff-facing payout-destination cell. List reads arrive PRE-MASKED from the
 * Postgres repo ("****<last4>") — the full account string never reaches a
 * staff view at rest. Opening "reveal" calls the AUDITED server action
 * (staff session + partner scope + an append-only audit_events row) and shows
 * the decrypted value in place.
 *
 * Destinations with nothing masked (e.g. a UPI handle with <4 digits) render
 * plainly without a toggle.
 */
export function MaskedDestination({
  transferId,
  payoutMethod,
  payoutDestination,
}: {
  transferId: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const method = payoutMethod.toUpperCase();
  const canReveal = /^\*{4}/.test(payoutDestination);

  if (!canReveal) {
    return (
      <div className="mt-0.5 text-xs text-muted-foreground">
        {method} · {payoutDestination}
      </div>
    );
  }

  return (
    <details
      className="group mt-0.5 text-xs text-muted-foreground"
      onToggle={async (e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || full || failed) return;
        const result = await revealDestinationAction(transferId);
        if ('destination' in result) setFull(result.destination);
        else setFailed(true);
      }}
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden after:font-semibold after:text-primary after:content-['_·_reveal'] group-open:after:content-['_·_hide']">
        {method} · {payoutDestination}
      </summary>
      <span className="mt-0.5 block tabular-nums text-foreground">
        {failed ? 'Reveal failed' : (full ?? '…')}
      </span>
    </details>
  );
}
