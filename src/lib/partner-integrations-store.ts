import { getDb, type DbOrTx } from '@/db/client';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import type { EncryptionKeyProvider } from './field-crypto';
import type { PartnerId } from './types';

// partner-integrations-store — CUT OVER to Postgres (Stage 2a). Same module
// path + surface (getIntegrations / saveIntegrations / deleteIntegrations);
// secrets remain envelope-encrypted inside the repo (now into *_enc columns),
// callers still only ever see plaintext config or the fully-defaulted EMPTY.
//
// Bonus of the relational home: partnerForPhoneNumberId is a direct indexed
// lookup on the SAME row the partner edits — the separate Redis pnid reverse
// index (and its write-two-places drift risk) is gone.

export function createPartnerIntegrationsStore(
  db: DbOrTx,
  provider?: EncryptionKeyProvider,
) {
  return createIntegrationsRepo(db, provider);
}

export type PartnerIntegrationsStore = ReturnType<typeof createPartnerIntegrationsStore>;

let cached: PartnerIntegrationsStore | null = null;

export function getPartnerIntegrationsStore(): PartnerIntegrationsStore {
  if (!cached) cached = createPartnerIntegrationsStore(getDb());
  return cached;
}

/** Inbound WhatsApp routing: the partner that owns a Meta phone_number_id. */
export async function partnerForPhoneNumberId(
  phoneNumberId: string,
): Promise<PartnerId | null> {
  return getPartnerIntegrationsStore().partnerForPhoneNumberId(phoneNumberId);
}
