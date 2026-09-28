import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { customerPortalPrefs } from '@/db/schema';
import { decodeMasterKey, decryptField } from './field-crypto';
import { customerEmailCtx } from './crypto-context';
import { env } from './env';
import type { Customer, PartnerId } from './types';

/**
 * portal-prefs — the customer portal preferences (customer_portal_prefs, migration 0027). UI redesign
 * M2-7 adds the READ side for "Email me a receipt"; M2-11 (Task 11.4) adds the writers (the email
 * change and the verify link) and MUST stamp `email_verified_tag` with emailVerifiedTag() below.
 *
 * The tag contract: hex(HMAC-SHA256(K, `${partnerId}|${phone}|${normalized email}`)), where
 * K = HKDF-SHA256(decodeMasterKey(FIELD_ENCRYPTION_KEY), salt "", info PORTAL_EMAIL_TAG_INFO, 32)
 * and the email is trimmed and lower-cased. Keyed (an address is guessable) and bound to the row, so
 * an email change voids verification and one tenant's tag never passes on another's row. The
 * address itself lives only in customers.email_enc. Pinned by a fixed-key vector
 * (tests/portal-prefs.test.ts).
 */

export const PORTAL_EMAIL_TAG_INFO = 'smartremit/portal-email-tag/v1';

let cachedKey: Buffer | null = null;
function defaultKey(): Buffer {
  if (!cachedKey) cachedKey = Buffer.from(hkdfSync('sha256', decodeMasterKey(env.fieldEncryptionKey), '', PORTAL_EMAIL_TAG_INFO, 32));
  return cachedKey;
}

/**
 * The verified-address tag. `masterKey` (tests only) is the RAW master key; the HKDF sub-key is
 * derived from it exactly as in production.
 */
export function emailVerifiedTag(partnerId: PartnerId, phone: string, email: string, masterKey?: Buffer): string {
  const key = masterKey ? Buffer.from(hkdfSync('sha256', masterKey, '', PORTAL_EMAIL_TAG_INFO, 32)) : defaultKey();
  return createHmac('sha256', key).update(`${partnerId}|${phone}|${email.trim().toLowerCase()}`).digest('hex');
}

export interface PortalPrefs {
  emailReceipts: boolean;
  emailVerifiedAt: Date | null;
  emailVerifiedTag: string | null;
}

/** One customer's prefs row on THIS tenant, or null. */
export async function getPortalPrefs(db: DbOrTx, partnerId: PartnerId, phone: string): Promise<PortalPrefs | null> {
  const rows = await db
    .select({
      emailReceipts: customerPortalPrefs.emailReceipts,
      emailVerifiedAt: customerPortalPrefs.emailVerifiedAt,
      emailVerifiedTag: customerPortalPrefs.emailVerifiedTag,
    })
    .from(customerPortalPrefs)
    .where(and(eq(customerPortalPrefs.partnerId, partnerId), eq(customerPortalPrefs.phone, phone)))
    .limit(1);
  return rows[0] ?? null;
}

function sameTag(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The customer's CURRENT email address when it is verified (email_verified_at set AND the stored tag
 * equals the tag of the address on file now), else null. Never throws on a bad blob.
 */
export async function verifiedReceiptEmail(
  db: DbOrTx,
  customer: Pick<Customer, 'partnerId' | 'senderPhone' | 'email'>,
): Promise<string | null> {
  const prefs = await getPortalPrefs(db, customer.partnerId, customer.senderPhone);
  if (!prefs?.emailVerifiedAt || !prefs.emailVerifiedTag || !customer.email) return null;
  let email: string;
  try {
    email = decryptField(customer.email, undefined, customerEmailCtx(customer));
  } catch {
    return null;
  }
  if (!email) return null;
  return sameTag(prefs.emailVerifiedTag, emailVerifiedTag(customer.partnerId, customer.senderPhone, email)) ? email : null;
}
