import type { Db } from '@/db/client';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import type { PartnerId } from '@/lib/types';

// helpers-esign — Fix pack 6 T4 (P24): THE one E-SIGN consent fixture of the pay-route
// tests. Puts a consent on file for the OWNER (partnerId, phone): ensureCustomer (the
// partner row must exist first: call it after seedPartner), then recordEsignConsent at
// a minute ago (relative date). { version } records another version; { withdrawn: true }
// then withdraws it (esignConsentNeeded true). Idempotent. Never hand-write the consent
// columns in a test. The customer repo is loaded dynamically, like seedOriginatorForTest
// (tests/helpers-live.ts), because some files vi.mock it.
export async function seedEsignConsentForTest(
  db: Db,
  partnerId: PartnerId,
  phone: string,
  o: { version?: string; withdrawn?: boolean } = {},
): Promise<void> {
  const { createCustomerRepo, recordEsignConsent, withdrawEsignConsent } = await import('@/db/repos/customer-repo');
  await createCustomerRepo(db, async () => null).ensureCustomer(partnerId, phone);
  await recordEsignConsent(db, partnerId, phone, o.version ?? ESIGN_CONSENT_VERSION, new Date(Date.now() - 60_000));
  if (o.withdrawn) await withdrawEsignConsent(db, partnerId, phone, new Date());
}
