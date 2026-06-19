import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { resolveSenderNames } from '@/lib/sender-names';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const now = '2026-06-09T12:00:00.000Z';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

function customer(over: Partial<Customer> & { senderPhone: string }): Customer {
  return {
    firstSeenAt: now,
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('resolveSenderNames', () => {
  it('returns the DECRYPTED name for senders that have one; absent otherwise', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230001', fullName: 'Asha Patel' }));
    await repo.saveCustomer(customer({ senderPhone: '15551230002' })); // pre-KYC, no name
    // 15551230003 has NO customer row at all.

    const map = await resolveSenderNames(
      db,
      ['15551230001', '15551230002', '15551230003'],
      provider,
    );
    expect(map.get('15551230001')).toBe('Asha Patel');
    expect(map.has('15551230002')).toBe(false); // no captured name → caller falls back to phone
    expect(map.has('15551230003')).toBe(false); // no customer → falls back to phone
  });

  it('empty input → empty map', async () => {
    expect((await resolveSenderNames(db, [], provider)).size).toBe(0);
  });

  it('dedupes repeated phones into one entry', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230009', fullName: 'Mo Khan' }));
    const map = await resolveSenderNames(db, ['15551230009', '15551230009'], provider);
    expect(map.get('15551230009')).toBe('Mo Khan');
    expect(map.size).toBe(1);
  });
});
