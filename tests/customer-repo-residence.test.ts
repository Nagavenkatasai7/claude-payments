import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';

// Fix pack 8 T8 (P7): the verified US state of residence. READ-ONLY on Customer
// (mapped in rowToCustomer only); setResidenceState is the only writer; a staff
// check is never overwritten by an API attestation. Phones are invented placeholders.

const PHONE = '15551230812';
const PA = 'pa';
const PB = 'pb';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

type Raw = { residence_state: string | null; residence_state_source: string | null; residence_state_at: string | null };
async function raw(db: Db, partnerId: string, phone = PHONE): Promise<Raw | undefined> {
  const r = (await db.execute(sql.raw(
    `SELECT residence_state, residence_state_source, residence_state_at::text
     FROM customers WHERE partner_id = '${partnerId}' AND phone = '${phone}'`,
  ))) as unknown as { rows: Raw[] };
  return r.rows[0];
}

function customerFor(partnerId: string, phone = PHONE): Customer {
  const at = minutesAgo(60).toISOString();
  return {
    senderPhone: phone, firstSeenAt: at, kycStatus: 'not_started', senderCountry: 'US', partnerId,
    createdAt: at, updatedAt: at,
  };
}

describe('customer residence repo (P7)', () => {
  let db: Db;
  let repo: ReturnType<typeof createCustomerRepo>;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, PA);
    await seedPartner(db, PB);
    repo = createCustomerRepo(db, async () => null);
    await repo.saveCustomer(customerFor(PA));
  });

  it('setResidenceState partner_attested on an empty row -> set; getCustomer maps state, source and ISO time', async () => {
    const at = minutesAgo(5);
    expect(await repo.setResidenceState(PA, PHONE, { state: 'NJ', source: 'partner_attested', at })).toBe('set');
    const c = await repo.getCustomer(PA, PHONE);
    expect(c?.residenceState).toBe('NJ');
    expect(c?.residenceStateSource).toBe('partner_attested');
    expect(c?.residenceStateAt).toBe(at.toISOString());
    expect(c?.updatedAt).toBe(at.toISOString());
  });

  it('partner_attested again with another state -> set (an API attestation may replace an API attestation)', async () => {
    expect(await repo.setResidenceState(PA, PHONE, { state: 'NJ', source: 'partner_attested', at: minutesAgo(10) })).toBe('set');
    const at = minutesAgo(2);
    expect(await repo.setResidenceState(PA, PHONE, { state: 'CA', source: 'partner_attested', at })).toBe('set');
    const c = await repo.getCustomer(PA, PHONE);
    expect([c?.residenceState, c?.residenceStateSource, c?.residenceStateAt]).toEqual(['CA', 'partner_attested', at.toISOString()]);
  });

  it('staff_verified always writes, and a later partner_attested is kept', async () => {
    await repo.setResidenceState(PA, PHONE, { state: 'NJ', source: 'partner_attested', at: minutesAgo(20) });
    const staffAt = minutesAgo(10);
    expect(await repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'staff_verified', at: staffAt })).toBe('set');
    expect(await repo.setResidenceState(PA, PHONE, { state: 'NJ', source: 'partner_attested', at: minutesAgo(1) })).toBe('kept');
    const c = await repo.getCustomer(PA, PHONE);
    expect([c?.residenceState, c?.residenceStateSource, c?.residenceStateAt]).toEqual(['NY', 'staff_verified', staffAt.toISOString()]);
  });

  it('staff_verified replaces an older staff check', async () => {
    await repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'staff_verified', at: minutesAgo(10) });
    const at = minutesAgo(1);
    expect(await repo.setResidenceState(PA, PHONE, { state: 'TX', source: 'staff_verified', at })).toBe('set');
    const c = await repo.getCustomer(PA, PHONE);
    expect([c?.residenceState, c?.residenceStateSource, c?.residenceStateAt]).toEqual(['TX', 'staff_verified', at.toISOString()]);
  });

  it('no row for the tenant -> no_customer and nothing written; tenant scope both ways', async () => {
    expect(await repo.setResidenceState(PB, PHONE, { state: 'NY', source: 'staff_verified', at: minutesAgo(1) })).toBe('no_customer');
    expect(await raw(db, PB)).toBeUndefined();
    expect(await raw(db, PA)).toEqual({ residence_state: null, residence_state_source: null, residence_state_at: null });
    // The same phone under 'pb' is untouched by a 'pa' write.
    await repo.saveCustomer(customerFor(PB));
    expect(await repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'staff_verified', at: minutesAgo(1) })).toBe('set');
    expect(await raw(db, PB)).toEqual({ residence_state: null, residence_state_source: null, residence_state_at: null });
    expect(await repo.setResidenceState(PB, PHONE, { state: 'CA', source: 'partner_attested', at: minutesAgo(1) })).toBe('set');
    expect((await raw(db, PA))?.residence_state).toBe('NY');
  });

  it("refuses a non-code state ('ny', 'XX', '') and the reserved source 'kyc_vendor' with TypeError; nothing written", async () => {
    const at = minutesAgo(1);
    for (const state of ['ny', 'XX', '']) {
      await expect(
        repo.setResidenceState(PA, PHONE, { state: state as 'NY', source: 'staff_verified', at }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'kyc_vendor' as 'staff_verified', at }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'chat' as 'staff_verified', at }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await raw(db, PA)).toEqual({ residence_state: null, residence_state_source: null, residence_state_at: null });
  });

  it('saveCustomer never clears or sets the columns', async () => {
    const staffAt = minutesAgo(10);
    await repo.setResidenceState(PA, PHONE, { state: 'NY', source: 'staff_verified', at: staffAt });
    await repo.saveCustomer({ ...customerFor(PA), kycStatus: 'verified' });
    let c = await repo.getCustomer(PA, PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect([c?.residenceState, c?.residenceStateSource, c?.residenceStateAt]).toEqual(['NY', 'staff_verified', staffAt.toISOString()]);
    await repo.saveCustomer({ ...customerFor(PA), residenceState: 'CA', residenceStateSource: 'partner_attested' } as Customer);
    c = await repo.getCustomer(PA, PHONE);
    expect([c?.residenceState, c?.residenceStateSource, c?.residenceStateAt]).toEqual(['NY', 'staff_verified', staffAt.toISOString()]);
  });

  it('customerToRow never names the columns', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/repos/customer-repo.ts'), 'utf8');
    const start = src.indexOf('function customerToRow');
    expect(start).toBeGreaterThan(0);
    const rest = src.slice(start + 1);
    const ends = ['\n  function ', '\n  const '].map((m) => rest.indexOf(m)).filter((i) => i > 0);
    const body = rest.slice(0, Math.min(...ends));
    expect(body).toContain('kycStatus');
    expect(body).not.toContain('residenceState');
    expect(body).not.toContain('residence_state');
  });

  it('the reader drops a half-written row; the reserved source kyc_vendor is readable', async () => {
    await db.execute(sql.raw(`UPDATE customers SET residence_state = 'NY' WHERE partner_id = '${PA}' AND phone = '${PHONE}'`));
    let c = await repo.getCustomer(PA, PHONE);
    expect(c && 'residenceState' in c).toBe(false);
    expect(c && 'residenceStateSource' in c).toBe(false);
    await db.execute(sql.raw(`UPDATE customers SET residence_state = NULL, residence_state_source = 'staff_verified' WHERE partner_id = '${PA}' AND phone = '${PHONE}'`));
    c = await repo.getCustomer(PA, PHONE);
    expect(c && 'residenceState' in c).toBe(false);
    expect(c && 'residenceStateSource' in c).toBe(false);
    await db.execute(sql.raw(`UPDATE customers SET residence_state = 'ny', residence_state_source = 'staff_verified' WHERE partner_id = '${PA}' AND phone = '${PHONE}'`));
    c = await repo.getCustomer(PA, PHONE);
    expect(c && 'residenceState' in c).toBe(false);
    expect(c && 'residenceStateSource' in c).toBe(false);
    await db.execute(sql.raw(`UPDATE customers SET residence_state = 'NY', residence_state_source = 'kyc_vendor' WHERE partner_id = '${PA}' AND phone = '${PHONE}'`));
    c = await repo.getCustomer(PA, PHONE);
    expect(c?.residenceState).toBe('NY');
    expect(c?.residenceStateSource).toBe('kyc_vendor');
  });

  it('insertCustomerIfAbsent leaves the columns NULL even for an object carrying a state', async () => {
    const other = '15551230813';
    expect(
      await repo.insertCustomerIfAbsent({ ...customerFor(PA, other), residenceState: 'CA', residenceStateSource: 'staff_verified', residenceStateAt: minutesAgo(1).toISOString() } as Customer),
    ).toBe(true);
    expect(await raw(db, PA, other)).toEqual({ residence_state: null, residence_state_source: null, residence_state_at: null });
  });
});
