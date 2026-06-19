import { inArray } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { openOptional } from '@/db/repos/mappers';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';

// sender-names — batch-resolve the DECRYPTED legal name for a set of sender
// phones, in ONE query, so a transfer list can show "who is sending" without an
// N+1 of per-row customer reads. The name lives ENCRYPTED on the customer record
// (customers.full_name_enc) and is only present after KYC — phones with no
// customer or no captured name are simply ABSENT from the map, and callers fall
// back to showing the phone. Reuses the exact customer-repo decryption path
// (openOptional + the field-crypto provider), so it inherits the same key
// boundary and never logs the plaintext.

/**
 * Map sender phone → decrypted full name, for the phones that have one.
 * Empty input or no matches ⇒ an empty map (callers fall back to the phone).
 */
export async function resolveSenderNames(
  db: DbOrTx,
  phones: string[],
  provider: EncryptionKeyProvider = defaultProvider(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(phones)].filter(Boolean);
  if (unique.length === 0) return out;

  const rows = await db
    .select({ phone: customers.phone, fullNameEnc: customers.fullNameEnc })
    .from(customers)
    .where(inArray(customers.phone, unique));

  for (const r of rows) {
    const name = openOptional(r.fullNameEnc, provider);
    if (name) out.set(r.phone, name);
  }
  return out;
}
