import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';
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

describe('resolveSenderNames (tenant-keyed — fix 1 / F50, F52)', () => {
  it('returns the DECRYPTED name for senders that have one under the caller tenant; absent otherwise', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230001', fullName: 'Asha Patel' }));
    await repo.saveCustomer(customer({ senderPhone: '15551230002' })); // pre-KYC, no name
    // 15551230003 has NO customer row at all.
    const map = await resolveSenderNames(
      db,
      [
        { partnerId: 'default', phone: '15551230001' },
        { partnerId: 'default', phone: '15551230002' },
        { partnerId: 'default', phone: '15551230003' },
      ],
      { provider },
    );
    expect(map.get(senderNameKey('default', '15551230001'))).toBe('Asha Patel');
    expect(map.has(senderNameKey('default', '15551230002'))).toBe(false);
    expect(map.has(senderNameKey('default', '15551230003'))).toBe(false);
  });

  it('omits customers belonging to another partner', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230001', fullName: 'Asha Patel' })); // default's
    const map = await resolveSenderNames(db, [{ partnerId: 'acme', phone: '15551230001' }], { provider });
    expect(map.size).toBe(0);
  });

  it('a phone with rows under two partners resolves ONLY the caller tenant name', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230007', fullName: 'Default Name' }));
    await repo.saveCustomer(customer({ senderPhone: '15551230007', partnerId: 'acme', fullName: 'Acme Name' }));
    const map = await resolveSenderNames(db, [{ partnerId: 'acme', phone: '15551230007' }], { provider });
    expect([...map.entries()]).toEqual([[senderNameKey('acme', '15551230007'), 'Acme Name']]);
  });

  it('empty input → empty map; repeated keys dedupe into one entry', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230009', fullName: 'Mo Khan' }));
    expect((await resolveSenderNames(db, [], { provider })).size).toBe(0);
    const map = await resolveSenderNames(
      db,
      [{ partnerId: 'default', phone: '15551230009' }, { partnerId: 'default', phone: '15551230009' }],
      { provider },
    );
    expect(map.get(senderNameKey('default', '15551230009'))).toBe('Mo Khan');
    expect(map.size).toBe(1);
  });
});
