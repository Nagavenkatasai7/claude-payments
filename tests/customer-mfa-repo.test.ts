import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createCorridorRequestRepo } from '@/db/repos/aux-repos';
import { EnvKeyProvider, decryptField, __setFieldCryptoWriteV2ForTests } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { Customer } from '@/lib/types';

// Program-Fix 49D (migration 0020): the customer portal TOTP columns and the
// corridor lead status. The MFA columns have single-column writers only;
// saveCustomer's whole-row upsert must never touch them.

const provider = new EnvKeyProvider(Buffer.alloc(32, 9));
const PHONE = '15550001234';
const B32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let db: Db;

beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => __setFieldCryptoWriteV2ForTests(false));

async function raw(query: string): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql.raw(query));
  return (res as unknown as { rows: Record<string, unknown>[] }).rows;
}

function repo() {
  return createCustomerRepo(db, async () => null, provider);
}

function customer(over: Partial<Customer> = {}): Customer {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    senderPhone: PHONE,
    partnerId: 'default',
    firstSeenAt: now,
    kycStatus: 'not_started',
    senderCountry: 'US',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Customer;
}

describe('migration 0020 columns exist (PGlite runs the real drizzle chain)', () => {
  it('customers.mfa_totp_enc, customers.mfa_enrolled_at, corridor_requests.status are nullable', async () => {
    const cols = await raw(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE (table_name = 'customers' AND column_name IN ('mfa_totp_enc','mfa_enrolled_at'))
          OR (table_name = 'corridor_requests' AND column_name = 'status')
       ORDER BY table_name, column_name`,
    );
    expect(cols).toEqual([
      { table_name: 'corridor_requests', column_name: 'status', is_nullable: 'YES', column_default: null },
      { table_name: 'customers', column_name: 'mfa_enrolled_at', is_nullable: 'YES', column_default: null },
      { table_name: 'customers', column_name: 'mfa_totp_enc', is_nullable: 'YES', column_default: null },
    ]);
  });
});

describe('customer-repo MFA writers', () => {
  it('a new customer is not enrolled; readMfa is null', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    expect((await r.getCustomer('default', PHONE))?.mfaEnrolledAt).toBeUndefined();
    expect(await r.readMfa('default', PHONE)).toBeNull();
  });

  it('enableMfa seals the secret for its own row and sets mfaEnrolledAt; readMfa opens it', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    expect(await r.enableMfa('default', PHONE, B32)).toBe(true);
    const [row] = await raw(`SELECT mfa_totp_enc, mfa_enrolled_at FROM customers WHERE phone = '${PHONE}'`);
    expect(String(row.mfa_totp_enc)).not.toContain(B32); // never plaintext at rest
    expect(row.mfa_enrolled_at).not.toBeNull();
    expect((await r.readMfa('default', PHONE))?.secretBase32).toBe(B32);
    expect((await r.getCustomer('default', PHONE))?.mfaEnrolledAt).toBeTruthy();
  });

  it('v2 writes (46B) bind the row context: a blob moved to another row does not open', async () => {
    __setFieldCryptoWriteV2ForTests(true);
    const r = repo();
    await r.saveCustomer(customer());
    await r.saveCustomer(customer({ senderPhone: '15550009999' }));
    await r.enableMfa('default', PHONE, B32);
    const [row] = await raw(`SELECT mfa_totp_enc FROM customers WHERE phone = '${PHONE}'`);
    const blob = String(row.mfa_totp_enc);
    expect(blob.startsWith('v2.')).toBe(true);
    expect(decryptField(blob, provider, ctx.customer('default', PHONE, 'mfa_totp_enc'))).toBe(B32);
    await raw(`UPDATE customers SET mfa_totp_enc = '${blob}' WHERE phone = '15550009999'`);
    await expect(r.readMfa('default', '15550009999')).rejects.toThrow();
  });

  it('enableMfa never overwrites an existing enrolment', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    await r.enableMfa('default', PHONE, B32);
    expect(await r.enableMfa('default', PHONE, 'ABCDEFGHABCDEFGH')).toBe(false);
    expect((await r.readMfa('default', PHONE))?.secretBase32).toBe(B32);
  });

  it('enableMfa on a missing row writes nothing', async () => {
    expect(await repo().enableMfa('default', PHONE, B32)).toBe(false);
  });

  it('saveCustomer (whole-row upsert, as every KYC / consent write does) leaves the enrolment alone', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    await r.enableMfa('default', PHONE, B32);
    const fresh = (await r.getCustomer('default', PHONE))!;
    await r.saveCustomer({ ...fresh, kycStatus: 'verified', mfaEnrolledAt: undefined });
    expect((await r.readMfa('default', PHONE))?.secretBase32).toBe(B32);
  });

  it('clearMfa turns it off (both columns) and says whether anything was on', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    await r.enableMfa('default', PHONE, B32);
    expect(await r.clearMfa('default', PHONE)).toBe(true);
    expect(await r.readMfa('default', PHONE)).toBeNull();
    const [row] = await raw(`SELECT mfa_totp_enc, mfa_enrolled_at FROM customers WHERE phone = '${PHONE}'`);
    expect(row).toEqual({ mfa_totp_enc: null, mfa_enrolled_at: null });
    expect(await r.clearMfa('default', PHONE)).toBe(false);
  });

  it('is tenant-scoped: another partner row for the same phone is untouched', async () => {
    const r = repo();
    await seedPartner(db, 'acme');
    await r.saveCustomer(customer());
    await r.saveCustomer(customer({ partnerId: 'acme' }));
    await r.enableMfa('default', PHONE, B32);
    expect(await r.readMfa('acme', PHONE)).toBeNull();
    expect(await r.clearMfa('acme', PHONE)).toBe(false);
    expect((await r.readMfa('default', PHONE))?.secretBase32).toBe(B32);
  });

  it('resealMfa rewrites only when the fresh seal is a different version and the blob is unchanged', async () => {
    const r = repo();
    await r.saveCustomer(customer());
    await r.enableMfa('default', PHONE, B32); // v1 today
    const before = (await r.readMfa('default', PHONE))!;
    expect(before.sealed.startsWith('v1.')).toBe(true);
    expect(await r.resealMfa('default', PHONE, before.sealed, B32)).toBe(false); // same version: no write
    __setFieldCryptoWriteV2ForTests(true);
    expect(await r.resealMfa('default', PHONE, 'v1.stale', B32)).toBe(false); // lost the race: no write
    expect(await r.resealMfa('default', PHONE, before.sealed, B32)).toBe(true);
    const after = (await r.readMfa('default', PHONE))!;
    expect(after.sealed.startsWith('v2.')).toBe(true);
    expect(after.secretBase32).toBe(B32);
  });
});

describe('corridor_requests.status (0020)', () => {
  it('a lead saved without a status reads back with no status field (NULL = open)', async () => {
    const c = createCorridorRequestRepo(db);
    await c.saveCorridorRequest({ id: 'cr_1', senderPhone: PHONE, destinationCountry: 'Kenya', capturedAt: '2026-09-01T00:00:00.000Z' });
    const [lead] = await c.listCorridorRequests();
    expect(lead).toEqual({ id: 'cr_1', senderPhone: PHONE, destinationCountry: 'Kenya', capturedAt: '2026-09-01T00:00:00.000Z' });
  });

  it('a stored status is read back', async () => {
    const c = createCorridorRequestRepo(db);
    await c.saveCorridorRequest({ id: 'cr_2', senderPhone: PHONE, destinationCountry: 'Kenya', capturedAt: '2026-09-01T00:00:00.000Z' });
    await raw(`UPDATE corridor_requests SET status = 'declined' WHERE id = 'cr_2'`);
    expect((await c.listCorridorRequests())[0].status).toBe('declined');
  });
});
