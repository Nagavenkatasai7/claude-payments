import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import type { Db } from '@/db/client';
import { customerPortalPrefs } from '@/db/schema';
import { encryptField } from '@/lib/field-crypto';
import { customerEmailCtx } from '@/lib/crypto-context';
import { emailVerifiedTag, getPortalPrefs, PORTAL_EMAIL_TAG_INFO, verifiedReceiptEmail } from '@/lib/portal-prefs';
import { freshDb, seedPartner, seedSender } from './helpers-db';

// UI redesign M2-7, Task 7.3: the read side of the portal prefs (M2-11 adds the writers). The email
// tag is the CONTRACT M2-11's verify flow must use: HMAC-SHA256 under an HKDF sub-key of
// FIELD_ENCRYPTION_KEY (its own info label), over `partnerId|phone|normalized email`.

const PHONE = '14155550123';
const KEY = Buffer.alloc(32, 9);

describe('emailVerifiedTag', () => {
  it('fixed-key vector: HKDF(info) sub-key, input = partnerId|phone|trimmed lowercase email', () => {
    const sub = Buffer.from(hkdfSync('sha256', KEY, '', PORTAL_EMAIL_TAG_INFO, 32));
    const want = createHmac('sha256', sub).update(`pa|${PHONE}|user@example.com`).digest('hex');
    expect(PORTAL_EMAIL_TAG_INFO).toBe('smartremit/portal-email-tag/v1');
    expect(emailVerifiedTag('pa', PHONE, '  User@Example.COM ', KEY)).toBe(want);
  });
  it('is bound to the tenant and the phone', () => {
    const a = emailVerifiedTag('pa', PHONE, 'user@example.com', KEY);
    expect(emailVerifiedTag('pb', PHONE, 'user@example.com', KEY)).not.toBe(a);
    expect(emailVerifiedTag('pa', '14155550124', 'user@example.com', KEY)).not.toBe(a);
    expect(emailVerifiedTag('pa', PHONE, 'other@example.com', KEY)).not.toBe(a);
  });
});

describe('verifiedReceiptEmail', () => {
  let db: Db;
  const email = 'user@example.com';
  const sealed = (pid: string) => encryptField(email, undefined, customerEmailCtx({ partnerId: pid, senderPhone: PHONE }));
  const customer = (pid: string, blob?: string) => ({ partnerId: pid, senderPhone: PHONE, email: blob });
  const verify = async (pid: string, tag: string | null, at: Date | null = new Date()) => {
    await db.insert(customerPortalPrefs).values({ partnerId: pid, phone: PHONE, emailVerifiedAt: at, emailVerifiedTag: tag });
  };

  beforeEach(async () => {
    db = await freshDb();
    for (const p of ['pa', 'pb']) {
      await seedPartner(db, p);
      await seedSender(db, { partnerId: p, phone: PHONE });
    }
  });

  it('no prefs row → null', async () => {
    expect(await getPortalPrefs(db, 'pa', PHONE)).toBeNull();
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBeNull();
  });
  it('verified with the current address → the address', async () => {
    await verify('pa', emailVerifiedTag('pa', PHONE, email));
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBe(email);
  });
  it('not verified (no timestamp), or no address on file → null', async () => {
    await verify('pa', emailVerifiedTag('pa', PHONE, email), null);
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBeNull();
    expect(await verifiedReceiptEmail(db, customer('pa', undefined))).toBeNull();
  });
  it('the address changed since verification (tag mismatch) → null', async () => {
    await verify('pa', emailVerifiedTag('pa', PHONE, 'old@example.com'));
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBeNull();
  });
  it("B's verification never counts for A (the prefs row and the tag are per tenant)", async () => {
    await verify('pb', emailVerifiedTag('pb', PHONE, email));
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBeNull();
    // A row on A carrying B's tag does not pass either.
    await verify('pa', emailVerifiedTag('pb', PHONE, email));
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pa')))).toBeNull();
  });
  it('an undecryptable address → null (never throws)', async () => {
    await verify('pa', emailVerifiedTag('pa', PHONE, email));
    expect(await verifiedReceiptEmail(db, customer('pa', 'not-a-blob'))).toBeNull();
    // Sealed for another row: fails to open under A's context.
    expect(await verifiedReceiptEmail(db, customer('pa', sealed('pb')))).toBeNull();
  });
});
