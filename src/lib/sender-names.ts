import { and, eq, inArray, or } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { openOptional } from '@/db/repos/mappers';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import type { PartnerId } from '@/lib/types';

// sender-names — batch-resolve the DECRYPTED legal name for a set of senders, in
// ONE query, so a transfer list can show "who is sending" without an N+1 of
// per-row customer reads. The name lives ENCRYPTED on the customer record
// (customers.full_name_enc) and is only present after KYC.
//
// TENANT-KEYED (fix 1 / F50, F52): the lookup is by (partner_id, phone), never
// by phone alone — a partner can only ever see the legal name of ITS OWN row for
// a number, never another tenant's. Callers pass the transfer rows themselves
// (a Transfer carries partnerId + phone) and read back with senderNameKey(t).
// Reuses the exact customer-repo decryption path (openOptional + the field-crypto
// provider): same key boundary, never logs the plaintext, no new reveal surface.

export interface SenderKey {
  partnerId: PartnerId;
  phone: string;
}

/** The map key for a (tenant, phone) pair. */
export function senderNameKey(partnerId: PartnerId, phone: string): string {
  return `${partnerId}:${phone}`;
}

/**
 * Map senderNameKey(partnerId, phone) → decrypted full name, for the pairs that
 * have one. Empty input or no matches ⇒ an empty map (callers fall back to the phone).
 */
export async function resolveSenderNames(
  db: DbOrTx,
  keys: readonly SenderKey[],
  opts: { provider?: EncryptionKeyProvider } = {},
): Promise<Map<string, string>> {
  const provider = opts.provider ?? defaultProvider();
  const out = new Map<string, string>();

  const byPartner = new Map<PartnerId, Set<string>>();
  for (const k of keys) {
    if (!k.partnerId || !k.phone) continue;
    const set = byPartner.get(k.partnerId) ?? new Set<string>();
    set.add(k.phone);
    byPartner.set(k.partnerId, set);
  }
  if (byPartner.size === 0) return out;

  const conds = [...byPartner].map(([partnerId, phones]) =>
    and(eq(customers.partnerId, partnerId), inArray(customers.phone, [...phones])),
  );
  const rows = await db
    .select({ partnerId: customers.partnerId, phone: customers.phone, fullNameEnc: customers.fullNameEnc })
    .from(customers)
    .where(conds.length === 1 ? conds[0] : or(...conds));

  for (const r of rows) {
    const name = openOptional(r.fullNameEnc, provider);
    if (name) out.set(senderNameKey(r.partnerId, r.phone), name);
  }
  return out;
}
