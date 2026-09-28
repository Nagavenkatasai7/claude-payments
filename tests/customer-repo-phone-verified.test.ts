import { describe, it, expect } from 'vitest';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { freshDb, seedPartner } from './helpers-db';

// UI redesign M2-5: a portal sign-in proves the phone for ONE tenant row. A single-column,
// tenant-keyed COALESCE write: never saveCustomer, never the phone-only markPhoneVerified.

describe('customerRepo.setPhoneVerifiedIfUnset', () => {
  it('sets once (the first proof wins) and never touches the other tenant row', async () => {
    const db = await freshDb();
    await seedPartner(db, 'pa');
    await seedPartner(db, 'pb');
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('pa', '14155550101');
    await repo.ensureCustomer('pb', '14155550101');
    expect(await repo.setPhoneVerifiedIfUnset('pa', '14155550101')).toBe(true);
    const first = (await repo.getCustomer('pa', '14155550101'))!.phoneVerifiedAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    expect(await repo.setPhoneVerifiedIfUnset('pa', '14155550101')).toBe(true);
    expect((await repo.getCustomer('pa', '14155550101'))!.phoneVerifiedAt).toBe(first);
    expect((await repo.getCustomer('pb', '14155550101'))!.phoneVerifiedAt).toBeFalsy();
  });
  it('no row → false (nothing created)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    expect(await repo.setPhoneVerifiedIfUnset('default', '14155550199')).toBe(false);
    expect(await repo.getCustomer('default', '14155550199')).toBeNull();
  });
});
