// Fix pack 6 (R46, P2 reader, P3 predicate) — whether a customer must be asked for
// E-SIGN consent on the pay page. SERVER module (it imports the customer repo): a
// 'use client' file must never import it; forms use src/lib/legal/esign-consent.ts
// and pay-outcome.ts.

import type { DbOrTx } from '@/db/client';
import { readEsignConsent, type EsignConsentState } from '@/db/repos/customer-repo';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';

/**
 * true = ask for consent: no row, no or another version on file (a version bump re-asks
 * everyone), never consented, or withdrawn at or after the last consent.
 */
export function esignConsentNeeded(s: EsignConsentState | null, current: string = ESIGN_CONSENT_VERSION): boolean {
  return (
    !s ||
    s.version !== current ||
    !s.consentedAt ||
    (s.withdrawnAt !== null && s.withdrawnAt.getTime() >= s.consentedAt.getTime())
  );
}

/** A posted consent version counts only when it is exactly the current one. */
export function isCurrentEsignVersion(v: unknown): v is string {
  return v === ESIGN_CONSENT_VERSION;
}

/**
 * The page reader: never throws. A read error means "ask" (the box shows), logged with the
 * error NAME and the tenant only (never the error object, its message or the phone).
 */
export async function readEsignConsentNeeded(db: DbOrTx, partnerId: PartnerId, phone: string): Promise<boolean> {
  try {
    return esignConsentNeeded(await readEsignConsent(db, partnerId, phone));
  } catch (err) {
    logWarn('pay.esign-read', err instanceof Error ? err.name : 'error', { partnerId });
    return true;
  }
}
