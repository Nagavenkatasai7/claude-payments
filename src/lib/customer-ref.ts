import { createHmac, hkdfSync } from 'node:crypto';
import { decodeMasterKey, decryptField, encryptField } from '@/lib/field-crypto';
import { env } from '@/lib/env';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Customer, PartnerId } from '@/lib/types';

// customer-ref (Program-Fix 37, dash-04 / dash-05). SERVER-ONLY: it seals with
// FIELD_ENCRYPTION_KEY. Client components must never import this file; they
// reach it through openCustomerAction (a 'use server' export).
//
// 1. The staff customer detail URL is `/admin-dashboard/customers/<ref>`, where
//    ref = encryptField('cref1|<partnerId>|<phone>'). The phone never appears
//    in a URL (Vercel request logs, browser history, referrers). The blob
//    format `v1.<b64url>.<b64url>.<b64url>.<b64url>` is URL-safe. A fresh IV
//    and DEK per seal means a ref is not a stable identifier, which is why the
//    audit subject below is a separate keyed HMAC.
// 2. auditSubjectId is the stable, KEYED subject for audit rows about a
//    customer: `cust:` + hex(HMAC-SHA256(K, `${partnerId}|${phone}`)), where
//    K = HKDF-SHA256(decodeMasterKey(FIELD_ENCRYPTION_KEY), salt "", info
//    AUDIT_SUBJECT_INFO, 32). Keyed because phones are low-entropy: an unkeyed
//    hash is reversible by enumeration. The same master key as blind-index.ts
//    (set once, never rotated) under a distinct `info` label, so the sub-keys
//    are separated; PASSWORD_PEPPER is not reused (one key, one purpose).
//    boot-assert already requires FIELD_ENCRYPTION_KEY in production.
//    Pinned by a fixed-key vector in tests/customer-ref.test.ts.

const REF_PREFIX = 'cref1|';
const REF_SHAPE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PHONE_SHAPE = /^\d{6,15}$/;

/** Seal (partnerId, phone) into an opaque, URL-safe ref. */
export function sealCustomerRef(partnerId: PartnerId, phone: string): string {
  return encryptField(`${REF_PREFIX}${partnerId}|${phone}`);
}

/**
 * Open a ref. Returns null (never throws) for anything that is not a ref this
 * app sealed: a raw phone, junk, a tampered blob, or another field-crypto blob
 * (an encrypted email or name lacks the `cref1|` prefix).
 */
export function openCustomerRef(ref: string): { partnerId: PartnerId; phone: string } | null {
  if (typeof ref !== 'string' || ref.length > 1024 || !REF_SHAPE.test(ref)) return null;
  let plain: string;
  try {
    plain = decryptField(ref);
  } catch {
    return null;
  }
  if (!plain.startsWith(REF_PREFIX)) return null;
  const body = plain.slice(REF_PREFIX.length);
  const cut = body.lastIndexOf('|');
  if (cut <= 0) return null;
  const partnerId = body.slice(0, cut);
  const phone = body.slice(cut + 1);
  if (!PHONE_SHAPE.test(phone)) return null;
  return { partnerId, phone };
}

export const AUDIT_SUBJECT_INFO = 'smartremit/audit-subject/v1';

/** Derive the 32-byte audit-subject key. Throws when the master key is missing or malformed. */
export function deriveAuditSubjectKey(masterRaw: string | Buffer = env.fieldEncryptionKey): Buffer {
  const master = decodeMasterKey(masterRaw);
  return Buffer.from(hkdfSync('sha256', master, '', AUDIT_SUBJECT_INFO, 32));
}

let cachedKey: Buffer | null = null;
function defaultKey(): Buffer {
  if (!cachedKey) cachedKey = deriveAuditSubjectKey();
  return cachedKey;
}

/** `cust:<64 hex>`: the stable, keyed audit subject for one (tenant, phone). */
export function auditSubjectId(partnerId: PartnerId, phone: string, key: Buffer = defaultKey()): string {
  return `cust:${createHmac('sha256', key).update(`${partnerId}|${phone}`).digest('hex')}`;
}

// The decrypted identity fields the customer detail page renders. The audit
// row names which were shown, never their values.
const IDENTITY_FIELDS = [
  ['full_name', (c: Customer) => c.fullName],
  ['date_of_birth', (c: Customer) => c.dateOfBirth],
  ['nationality', (c: Customer) => c.nationality],
  ['residential_address', (c: Customer) => c.residentialAddress],
] as const;

/**
 * dash-05: record that a staff member viewed a customer's decrypted identity.
 * Writes ONE `pii.view` row when any identity field is present (none when all
 * are empty): actor = staff, subject = auditSubjectId of the RESOLVED row's
 * own (partnerId, senderPhone), meta = { fields } (names only). Awaited by
 * the page and not caught: if the audit write fails, the page fails rather
 * than show identity without a record. Returns whether a row was written.
 */
export async function auditIdentityView(
  db: DbOrTx,
  staff: { username: string },
  customer: Customer,
): Promise<boolean> {
  const fields = IDENTITY_FIELDS.filter(([, get]) => {
    const v = get(customer);
    return typeof v === 'string' && v.trim().length > 0;
  }).map(([name]) => name);
  if (fields.length === 0) return false;
  await createAuditRepo(db).record({
    partnerId: customer.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'pii.view',
    subjectId: auditSubjectId(customer.partnerId, customer.senderPhone),
    meta: { fields },
  });
  return true;
}
