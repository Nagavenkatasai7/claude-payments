import type { PayoutMethod } from '@/lib/types';
import { maskAccountDisplay } from '@/lib/payout-format';

/**
 * Staff-facing payout-destination cell. Shows "METHOD · ****<last4>" by DEFAULT
 * so the full account number / routing / sort / IFSC code / IBAN body never
 * surfaces in a staff view at rest. Compliance can still read the full string by
 * clicking "reveal" — a pure <details>/<summary> toggle (no client JS, so this
 * works inside both server and client component trees).
 *
 * UPI ids (no digits) pass through maskAccountDisplay unchanged; there's nothing
 * to hide and nothing to reveal, so we render the value plainly without a toggle.
 */
export function MaskedDestination({
  payoutMethod,
  payoutDestination,
}: {
  payoutMethod: PayoutMethod;
  payoutDestination: string;
}) {
  const masked = maskAccountDisplay(payoutDestination);
  const method = payoutMethod.toUpperCase();
  const canReveal = masked !== payoutDestination; // something was actually masked

  if (!canReveal) {
    return (
      <div className="sh-recipient-sub">
        {method} · {payoutDestination}
      </div>
    );
  }

  return (
    <details className="sh-reveal sh-recipient-sub">
      <summary>
        {method} · {masked}
      </summary>
      <span className="sh-reveal-full">{payoutDestination}</span>
    </details>
  );
}
