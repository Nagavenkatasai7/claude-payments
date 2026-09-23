import type { PartnerId } from './types';

// consent-gate — Program-Fix 49A (whatsapp-10d). The ONE opt-out check for
// business-initiated WhatsApp sends (outbox `whatsapp.*` rows and the direct
// senders). What survives STOP is decided per message by its category — the
// brief's B5 option (a), a table counsel may revise (changing a tag is one line
// at the producer):
//
//   essential    (still delivered after STOP): OTPs the customer requested,
//                settlement stage messages, rail-failure / refund notices,
//                payment received / delivered.
//   nonessential (suppressed after STOP): pay-link resends, support-ticket
//                notices, the B2B bill to a buyer, KYC nudges and decisions,
//                schedule links.
//
// A MISSING category is essential: rows written by the previous build (rolling
// overlap) carry none and must keep delivering. Only the exact string
// 'nonessential' suppresses.

export type MessageCategory = 'essential' | 'nonessential';

/** Normalise a raw payload value: only the exact string 'nonessential' is nonessential. */
export function messageCategory(raw: unknown): MessageCategory {
  return raw === 'nonessential' ? 'nonessential' : 'essential';
}

export interface OptOutLookup {
  getCustomer(
    partnerId: PartnerId,
    phone: string,
  ): Promise<{ optedOutAt?: string | null } | null | undefined>;
}

/**
 * The same rule on a customer row the caller already holds (no re-read):
 * true ⇒ do NOT send.
 */
export function optOutSuppresses(
  customer: { optedOutAt?: string | null } | null | undefined,
  category: unknown,
): boolean {
  return messageCategory(category) === 'nonessential' && Boolean(customer?.optedOutAt);
}

/**
 * True ⇒ do NOT send: the (tenant, phone) customer has opted out and the
 * message is not essential. Essential (or uncategorised) messages never read
 * the customer row. A lookup error propagates: the caller decides (the worker
 * retries the row; direct senders are already fail-soft).
 */
export async function suppressForOptOut(
  store: OptOutLookup,
  partnerId: PartnerId,
  phone: string,
  category: unknown,
): Promise<boolean> {
  if (messageCategory(category) === 'essential') return false;
  return optOutSuppresses(await store.getCustomer(partnerId, phone), category);
}
