import { describe, it, expect } from 'vitest';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { freshDb } from './helpers-db';

// Scheduled-send name nudge (2026-10-02), hardening: saveCustomer is a whole-row upsert, so a save
// built from a copy read BEFORE set_sender_name landed would write the old empty name back over the
// new one, and the owner's scheduled sends would stop again. A save that carries no name now keeps
// the name on file; a save that carries a name still writes it.

const PHONE = '14155550101';

describe('customerRepo.saveCustomer never blanks a legal name on file', () => {
  it('a stale copy with no name keeps the stored name and still writes its other fields', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    expect(stale.fullName).toBeFalsy();
    expect(await repo.setFullNameIfUnset('default', PHONE, 'Alex Rivera')).toBe(true);
    await repo.saveCustomer({ ...stale, occupation: 'salaried', updatedAt: new Date().toISOString() });
    const now = (await repo.getCustomer('default', PHONE))!;
    expect(now.fullName).toBe('Alex Rivera');
    expect(now.occupation).toBe('salaried');
  });

  it('an empty-string name on the copy is treated as no name', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    await repo.setFullNameIfUnset('default', PHONE, 'Alex Rivera');
    await repo.saveCustomer({ ...stale, fullName: '' });
    expect((await repo.getCustomer('default', PHONE))!.fullName).toBe('Alex Rivera');
  });

  it('a save that carries a name still writes it (explicit writes are unchanged)', async () => {
    const db = await freshDb();
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('default', PHONE);
    await repo.setFullNameIfUnset('default', PHONE, 'Alex Rivera');
    const c = (await repo.getCustomer('default', PHONE))!;
    await repo.saveCustomer({ ...c, fullName: 'Alex Q Rivera' });
    expect((await repo.getCustomer('default', PHONE))!.fullName).toBe('Alex Q Rivera');
  });
});
