import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { EnvKeyProvider, decryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { freshDb, seedPartner } from './helpers-db';

// Fix pack 5 T18 (P20): the sender's home address and date of birth (travel-rule originator
// data) are written once through set-if-unset setters and never lost by a whole-row save.
// All values below are invented placeholders.

const PHONE = '15551230042';
const ADDRESS = '1 Test Street, Testville TE1 1ST';
const ADDRESS_2 = '2 Other Road, Otherville OT2 2ND';
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return isoDay(d);
};
const DOB = yearsAgo(30);
const DOB_2 = yearsAgo(31);

const provider = new EnvKeyProvider(Buffer.alloc(32, 9));

async function raw(db: Awaited<ReturnType<typeof freshDb>>, q: string) {
  const r = (await db.execute(sql.raw(q))) as unknown as { rows: Array<Record<string, string | null>> };
  return r.rows;
}

describe('customerRepo.saveCustomer keeps the address and date of birth on file (P20)', () => {
  it('a stale copy with no address and no DOB keeps both on file and still writes its other fields', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    expect(stale.residentialAddress).toBeFalsy();
    expect(stale.dateOfBirth).toBeFalsy();
    expect(await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS)).toBe(true);
    expect(await repo.setDateOfBirthIfUnset('default', PHONE, DOB)).toBe(true);
    await repo.saveCustomer({ ...stale, occupation: 'salaried', updatedAt: new Date().toISOString() });
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.residentialAddress).toBe(ADDRESS);
    expect(now.dateOfBirth).toBe(DOB);
    expect(now.occupation).toBe('salaried');
  });

  it.each([
    ['empty strings', '', ''],
    ['whitespace', '   ', ' \t '],
  ])('an %s address / DOB on the copy counts as none', async (_l, address, dob) => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS);
    await repo.setDateOfBirthIfUnset('default', PHONE, DOB);
    await repo.saveCustomer({ ...stale, residentialAddress: address, dateOfBirth: dob });
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.residentialAddress).toBe(ADDRESS);
    expect(now.dateOfBirth).toBe(DOB);
  });

  it('a save that carries a value still writes it (explicit writes are unchanged)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS);
    await repo.setDateOfBirthIfUnset('default', PHONE, DOB);
    const c = (await repo.getCustomer('default', PHONE))!;
    await repo.saveCustomer({ ...c, residentialAddress: ADDRESS_2, dateOfBirth: DOB_2 });
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.residentialAddress).toBe(ADDRESS_2);
    expect(now.dateOfBirth).toBe(DOB_2);
  });
});

describe('setResidentialAddressIfUnset / setDateOfBirthIfUnset (P20)', () => {
  it('true on the first write; false when already set (value unchanged)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    expect(await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS)).toBe(true);
    expect(await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS_2)).toBe(false);
    expect(await repo.setDateOfBirthIfUnset('default', PHONE, DOB)).toBe(true);
    expect(await repo.setDateOfBirthIfUnset('default', PHONE, DOB_2)).toBe(false);
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.residentialAddress).toBe(ADDRESS);
    expect(now.dateOfBirth).toBe(DOB);
  });

  it('a stored empty string counts as unset (the setter fills it)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    await db.execute(sql`UPDATE customers SET residential_address_enc = '', date_of_birth_enc = ''`);
    expect(await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS)).toBe(true);
    expect(await repo.setDateOfBirthIfUnset('default', PHONE, DOB)).toBe(true);
  });

  it('false for a missing row, and for another tenant with the same phone', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme', 'Acme');
    const repo = createCustomerRepo(db, async () => null);
    expect(await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS)).toBe(false);
    expect(await repo.setDateOfBirthIfUnset('default', PHONE, DOB)).toBe(false);
    await repo.ensureCustomer('default', PHONE);
    expect(await repo.setResidentialAddressIfUnset('acme', PHONE, ADDRESS)).toBe(false);
    expect(await repo.setDateOfBirthIfUnset('acme', PHONE, DOB)).toBe(false);
    const rows = await raw(db, `SELECT residential_address_enc, date_of_birth_enc FROM customers`);
    expect(rows).toEqual([{ residential_address_enc: null, date_of_birth_enc: null }]);
  });

  it('getCustomer opens both (AAD = the row (partner_id, phone) and the column)', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme', 'Acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.ensureCustomer('acme', PHONE);
    await repo.setResidentialAddressIfUnset('acme', PHONE, ADDRESS);
    await repo.setDateOfBirthIfUnset('acme', PHONE, DOB);
    const [row] = await raw(db, `SELECT residential_address_enc, date_of_birth_enc FROM customers`);
    expect(row.residential_address_enc).toMatch(/^v2\.k0\./);
    expect(decryptField(row.residential_address_enc!, provider, ctx.customer('acme', PHONE, 'residential_address_enc'))).toBe(ADDRESS);
    expect(decryptField(row.date_of_birth_enc!, provider, ctx.customer('acme', PHONE, 'date_of_birth_enc'))).toBe(DOB);
    expect(() => decryptField(row.date_of_birth_enc!, provider, ctx.customer('acme', PHONE, 'residential_address_enc'))).toThrow();
    const c = (await repo.getCustomer('acme', PHONE))!;
    expect(c.residentialAddress).toBe(ADDRESS);
    expect(c.dateOfBirth).toBe(DOB);
  });

  it('the setters touch only their column (a concurrent fullName / kycStatus write survives)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    // A concurrent writer lands a name and a KYC decision after our read.
    await repo.setFullNameIfUnset('default', PHONE, 'Test Sender Placeholder');
    await repo.saveCustomer({ ...stale, fullName: 'Test Sender Placeholder', kycStatus: 'verified' });
    await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS);
    await repo.setDateOfBirthIfUnset('default', PHONE, DOB);
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.fullName).toBe('Test Sender Placeholder');
    expect(now.kycStatus).toBe('verified');
    expect(now.residentialAddress).toBe(ADDRESS);
    expect(now.dateOfBirth).toBe(DOB);
  });
});

describe('originatorOnFile (P20)', () => {
  function noDecryptProvider(base: EncryptionKeyProvider): EncryptionKeyProvider & { unwraps: number } {
    const p = {
      unwraps: 0,
      wrapDataKey: (dek: Buffer) => base.wrapDataKey(dek),
      unwrapDataKey: (wrapped: Buffer) => {
        p.unwraps += 1;
        throw new Error('originatorOnFile must never decrypt');
      },
    };
    return p;
  }

  it('{ address, dateOfBirth } by IS NOT NULL (and not \'\'); never decrypts', async () => {
    const db = await freshDb();
    const writer = createCustomerRepo(db, async () => null, provider);
    const guarded = noDecryptProvider(provider);
    const reader = createCustomerRepo(db, async () => null, guarded);
    await writer.ensureCustomer('default', PHONE);
    expect(await reader.originatorOnFile('default', PHONE)).toEqual({ address: false, dateOfBirth: false });
    await writer.setResidentialAddressIfUnset('default', PHONE, ADDRESS);
    expect(await reader.originatorOnFile('default', PHONE)).toEqual({ address: true, dateOfBirth: false });
    await writer.setDateOfBirthIfUnset('default', PHONE, DOB);
    expect(await reader.originatorOnFile('default', PHONE)).toEqual({ address: true, dateOfBirth: true });
    await db.execute(sql`UPDATE customers SET residential_address_enc = '', date_of_birth_enc = ''`);
    expect(await reader.originatorOnFile('default', PHONE)).toEqual({ address: false, dateOfBirth: false });
    expect(guarded.unwraps).toBe(0);
  });

  it('{ false, false } for a missing row; tenant-scoped', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme', 'Acme');
    const repo = createCustomerRepo(db, async () => null);
    expect(await repo.originatorOnFile('default', PHONE)).toEqual({ address: false, dateOfBirth: false });
    await repo.ensureCustomer('default', PHONE);
    await repo.setResidentialAddressIfUnset('default', PHONE, ADDRESS);
    await repo.setDateOfBirthIfUnset('default', PHONE, DOB);
    expect(await repo.originatorOnFile('acme', PHONE)).toEqual({ address: false, dateOfBirth: false });
    expect(await repo.originatorOnFile('default', PHONE)).toEqual({ address: true, dateOfBirth: true });
  });
});
