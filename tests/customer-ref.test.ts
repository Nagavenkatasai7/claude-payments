import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { freshDb, seedPartner } from './helpers-db';
import { encryptField, sealFieldV2, defaultProvider, __setFieldCryptoWriteV2ForTests } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import {
  sealCustomerRef,
  openCustomerRef,
  auditSubjectId,
  deriveAuditSubjectKey,
  AUDIT_SUBJECT_INFO,
  auditIdentityView,
} from '@/lib/customer-ref';
import type { Customer } from '@/lib/types';

// Program-Fix 37 (dash-04 / dash-05): the staff customer URL carries a sealed
// ref instead of the phone, and every render of decrypted identity writes one
// `pii.view` audit row whose subject is a KEYED, stable HMAC of (tenant, phone).

const PHONE = '15551230000';

describe('sealCustomerRef / openCustomerRef', () => {
  it('round-trips (partnerId, phone)', () => {
    expect(openCustomerRef(sealCustomerRef('acme', PHONE))).toEqual({ partnerId: 'acme', phone: PHONE });
  });

  it('is URL-safe and never contains the phone', () => {
    const ref = sealCustomerRef('acme', PHONE);
    expect(ref).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(ref.startsWith('v1.')).toBe(true);
    expect(ref).not.toContain(PHONE);
  });

  it('two seals of the same pair differ (random IV / DEK)', () => {
    expect(sealCustomerRef('acme', PHONE)).not.toBe(sealCustomerRef('acme', PHONE));
  });

  it('returns null (never throws) for a raw phone, a tampered ref, junk, or a blob without the cref1 prefix', () => {
    expect(openCustomerRef(PHONE)).toBeNull();
    expect(openCustomerRef('')).toBeNull();
    expect(openCustomerRef('v1.a.b.c.d')).toBeNull();
    expect(openCustomerRef('%2F..%2F')).toBeNull();
    const ref = sealCustomerRef('acme', PHONE);
    // Flip a character INSIDE the ciphertext segment (the final base64url char
    // can carry unused padding bits, so tampering it may not change a byte).
    const i = ref.lastIndexOf('.') + 2;
    const tampered = ref.slice(0, i) + (ref[i] === 'A' ? 'B' : 'A') + ref.slice(i + 1);
    expect(openCustomerRef(tampered)).toBeNull();
    expect(openCustomerRef(encryptField('someone@x.com'))).toBeNull();
    expect(openCustomerRef(encryptField(`cref1|acme|not-a-phone`))).toBeNull();
    expect(openCustomerRef(encryptField(`cref1||${PHONE}`))).toBeNull();
  });
});

describe('customer refs under the v2 envelope (fix 46A)', () => {
  it('a v2 ref (sealed under the customer_ref purpose) opens', () => {
    __setFieldCryptoWriteV2ForTests(true);
    try {
      const ref = sealCustomerRef('acme', PHONE);
      expect(ref.startsWith('v2.k0.')).toBe(true);
      expect(ref).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(openCustomerRef(ref)).toEqual({ partnerId: 'acme', phone: PHONE });
    } finally {
      __setFieldCryptoWriteV2ForTests(false);
    }
  });

  it('a v2 blob under a different context is not a ref (null, never throws)', () => {
    const other = sealFieldV2(`cref1|acme|${PHONE}`, defaultProvider(), ctx.customer('acme', PHONE, 'email_enc'));
    expect(openCustomerRef(other)).toBeNull();
    expect(openCustomerRef('v2.k0.a.b.c.d')).toBeNull();
    expect(openCustomerRef('v2.k9.a.b.c.d.e')).toBeNull();
  });
});

describe('auditSubjectId — keyed HMAC of (partnerId, phone)', () => {
  const HEX_KEY = '07'.repeat(32);

  it('is pinned: HMAC-SHA256(HKDF(master, "", AUDIT_SUBJECT_INFO, 32), `${partnerId}|${phone}`), prefixed cust:', () => {
    expect(AUDIT_SUBJECT_INFO).toBe('smartremit/audit-subject/v1');
    const key = deriveAuditSubjectKey(HEX_KEY);
    expect(key).toEqual(Buffer.from(hkdfSync('sha256', Buffer.from(HEX_KEY, 'hex'), '', AUDIT_SUBJECT_INFO, 32)));
    // Fixed-key test vector: changing the derivation orphans every stored subject.
    expect(auditSubjectId('acme', PHONE, key)).toBe(
      'cust:4f7b57b933f3f7dd27fd47f6582321757f36559c52e04b4097e9140bc1528f31',
    );
  });

  it('is stable per customer, differs across customers and tenants, and never contains the phone', () => {
    const a = auditSubjectId('acme', PHONE);
    expect(auditSubjectId('acme', PHONE)).toBe(a);
    expect(auditSubjectId('acme', '15551239999')).not.toBe(a);
    expect(auditSubjectId('other', PHONE)).not.toBe(a);
    expect(a).toMatch(/^cust:[0-9a-f]{64}$/);
    expect(a.includes(PHONE)).toBe(false);
  });

  it('is keyed: not any unkeyed hash of the identity, and changes with the key', () => {
    const key = deriveAuditSubjectKey('07'.repeat(32));
    const id = auditSubjectId('acme', PHONE, key).slice('cust:'.length);
    expect(id).not.toBe(createHash('sha256').update(`acme|${PHONE}`).digest('hex'));
    expect(id).not.toBe(createHmac('sha256', Buffer.from('07'.repeat(32), 'hex')).update(`acme|${PHONE}`).digest('hex'));
    expect(auditSubjectId('acme', PHONE, deriveAuditSubjectKey('11'.repeat(32)))).not.toBe(`cust:${id}`);
  });

  it('throws when the master key is missing (never an unkeyed fallback)', () => {
    expect(() => deriveAuditSubjectKey('')).toThrow(/FIELD_ENCRYPTION_KEY/);
  });
});

describe('auditIdentityView', () => {
  type Db = Awaited<ReturnType<typeof freshDb>>;
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'acme');
  });

  function customer(overrides: Partial<Customer> = {}): Customer {
    return {
      senderPhone: PHONE,
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'pending',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  async function rows() {
    const res = await db.execute(
      sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'pii.view'`,
    );
    return (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  }

  it('writes ONE pii.view row listing the present fields, with a keyed subject and no values', async () => {
    const wrote = await auditIdentityView(db, { username: 'alice' }, customer({
      fullName: 'Asha Ramanathan',
      dateOfBirth: '1987-03-14',
      residentialAddress: '42 Elm Street',
    }));
    expect(wrote).toBe(true);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ partner_id: 'acme', actor: 'alice', actor_type: 'staff', action: 'pii.view' });
    expect(r[0].subject_id).toBe(auditSubjectId('acme', PHONE));
    expect(r[0].meta).toEqual({ fields: ['full_name', 'date_of_birth', 'residential_address'] });
    const serialized = JSON.stringify(r[0]);
    for (const v of ['Asha', '1987-03-14', 'Elm', PHONE]) expect(serialized).not.toContain(v);
  });

  it('writes nothing when every identity field is empty', async () => {
    expect(await auditIdentityView(db, { username: 'alice' }, customer())).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it('two views of the same customer share one subject (who-viewed-X is answerable)', async () => {
    await auditIdentityView(db, { username: 'alice' }, customer({ fullName: 'A' }));
    await auditIdentityView(db, { username: 'bob' }, customer({ nationality: 'IN' }));
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0].subject_id).toBe(r[1].subject_id);
    expect(r[1].meta).toEqual({ fields: ['nationality'] });
  });
});
