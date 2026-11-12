/**
 * Fix pack 5 T20a (R38, P22): originatorInfoMissing, the ONE predicate the
 * settle hold and the releases (T20b) and the worker's G16 (T23) import.
 * Not exempt AND (routed OR the band's data not on file). The OWNER's
 * customer row is read; a failed read throws (the caller decides).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from '@/lib/store';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { originatorInfoMissing } from '@/lib/originator-info';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { CountryCode, PartnerId, Transfer } from '@/lib/types';

// The on-file read, with a fault toggle (the "read throws" case). Every other
// method of the repo is the real one.
const onFileFault = vi.hoisted(() => ({ throwOnRead: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...a: Parameters<typeof real.createCustomerRepo>) => {
      const r = real.createCustomerRepo(...a);
      return {
        ...r,
        originatorOnFile: async (...b: Parameters<typeof r.originatorOnFile>) => {
          if (onFileFault.throwOnRead) throw new Error('on-file read failed');
          return r.originatorOnFile(...b);
        },
      };
    },
  };
});

const ACME = 'acme' as PartnerId;
const PHONE = '15551230000';
const DOB = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'om_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: ACME, environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205, transferType: 'b2c',
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

async function row(over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = fixture(over);
  await store.saveTransfer(t);
  return t;
}

async function onFile(partnerId: PartnerId, o: { address?: boolean; dob?: boolean }): Promise<void> {
  const repo = createCustomerRepo(db, async () => null);
  await repo.ensureCustomer(partnerId, PHONE);
  if (o.address) await repo.setResidentialAddressIfUnset(partnerId, PHONE, '1 Test Street, Testville');
  if (o.dob) await repo.setDateOfBirthIfUnset(partnerId, PHONE, DOB);
}

const amount = (amountUsd: number, destinationCountry: CountryCode) => ({ amountUsd, destinationCountry });

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
  onFileFault.throwOnRead = false;
});

describe('originatorInfoMissing (P22)', () => {
  it('address required and not on file: true', async () => {
    const t = await row();
    expect(await originatorInfoMissing(db, t)).toBe(true);
  });

  it('address on file, $999 to IN: false', async () => {
    const t = await row(amount(999, 'IN' as CountryCode));
    await onFile(ACME, { address: true });
    expect(await originatorInfoMissing(db, t)).toBe(false);
  });

  it('$1,000 to GB without a DOB: true', async () => {
    const t = await row(amount(1000, 'GB' as CountryCode));
    await onFile(ACME, { address: true });
    expect(await originatorInfoMissing(db, t)).toBe(true);
  });

  it('$3,000 to IN with address and DOB: false', async () => {
    const t = await row(amount(3000, 'IN' as CountryCode));
    await onFile(ACME, { address: true, dob: true });
    expect(await originatorInfoMissing(db, t)).toBe(false);
  });

  it('$3,000 to IN with the address only: true', async () => {
    const t = await row(amount(3000, 'IN' as CountryCode));
    await onFile(ACME, { address: true });
    expect(await originatorInfoMissing(db, t)).toBe(true);
  });

  it('routed (settlementPartnerId set) with everything on file: true', async () => {
    const t = await row({ settlementPartnerId: 'beta' as PartnerId });
    await onFile(ACME, { address: true, dob: true });
    expect(await originatorInfoMissing(db, t)).toBe(true);
  });

  it('exempt (b2b, Partner API) with nothing on file: false', async () => {
    const b2b = await row({ id: 'om_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' } as Partial<Transfer>);
    const api = await row({ id: 'om_api' });
    await createIdempotencyRepo(db).claim(ACME, 'order-1', api.id);
    expect(await originatorInfoMissing(db, b2b)).toBe(false);
    expect(await originatorInfoMissing(db, api)).toBe(false);
  });

  it("the OWNER's customer row is read (another tenant's row with the same phone and an address does not count)", async () => {
    const t = await row();
    await onFile('beta' as PartnerId, { address: true, dob: true });
    expect(await originatorInfoMissing(db, t)).toBe(true);
    await onFile(ACME, { address: true });
    expect(await originatorInfoMissing(db, t)).toBe(false);
  });

  it('a failed read throws', async () => {
    const t = await row();
    onFileFault.throwOnRead = true;
    await expect(originatorInfoMissing(db, t)).rejects.toThrow('on-file read failed');
  });
});
