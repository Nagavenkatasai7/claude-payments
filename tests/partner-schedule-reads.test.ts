import { describe, it, expect, beforeEach } from 'vitest';
import { captureQueries, freshDb } from './helpers-db';
import { seedTwoTenants, seedPartnerTransfer } from './helpers-partner-app';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { getPartnerSchedule, listPartnerSchedules } from '@/db/repos/partner-schedule-reads';
import { listPartnerRefunds } from '@/db/repos/partner-transfer-reads';
import type { Db } from '@/db/client';
import type { Schedule } from '@/lib/types';

// Merge plan 2a/2b: the /partner Schedules and Refunds READS. The tenant is in the WHERE (another
// tenant's rows never appear, a foreign id reads as null), and the schedule read never selects the
// payout destination ciphertext, so nothing is decrypted for these pages.

let db: Db;
const DEST = 'ACCT 000111222333 IFSC HDFC0001';

function schedule(id: string, partnerId: string, o: Partial<Schedule> = {}): Schedule {
  return {
    id,
    phone: '15550009999',
    amountUsd: 120,
    recipientName: 'Firstname Lastname',
    recipientPhone: '919800002222',
    payoutMethod: 'bank',
    payoutDestination: DEST,
    fundingMethod: 'bank_transfer',
    frequency: 'monthly',
    dayOfMonth: 3,
    status: 'active',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    partnerId,
    sourceCurrency: 'USD',
    amountSource: 120,
    ...o,
  };
}

beforeEach(async () => {
  db = await freshDb();
  await seedTwoTenants(db);
  const repo = createScheduleRepo(db);
  await repo.saveSchedule(schedule('sa1', 'pa'));
  await repo.saveSchedule(schedule('sa2', 'pa', { status: 'paused', createdAt: new Date().toISOString(), frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 2, lastRunAt: new Date(Date.now() - 86_400_000).toISOString(), endDate: '2099-01-31' }));
  await repo.saveSchedule(schedule('sb1', 'pb'));
});

describe('listPartnerSchedules', () => {
  it("lists only the tenant's schedules, newest first", async () => {
    expect((await listPartnerSchedules(db, 'pa')).map((s) => s.id)).toEqual(['sa2', 'sa1']);
    expect((await listPartnerSchedules(db, 'pb')).map((s) => s.id)).toEqual(['sb1']);
  });
  it('maps the fields the page needs, with the stored last 4 and NO destination field', async () => {
    const [weekly, monthly] = await listPartnerSchedules(db, 'pa');
    expect(monthly).toMatchObject({ id: 'sa1', amountSource: 120, sourceCurrency: 'USD', frequency: 'monthly', dayOfMonth: 3, status: 'active', payoutDestinationLast4: 'HDFC0001'.slice(-4) });
    expect(weekly).toMatchObject({ id: 'sa2', frequency: 'weekly', dayOfWeek: 2, status: 'paused', endDate: '2099-01-31' });
    expect(weekly.dayOfMonth).toBeUndefined();
    expect(typeof weekly.lastRunAt).toBe('string');
    for (const s of [weekly, monthly]) {
      expect(s).not.toHaveProperty('payoutDestination');
      expect(s).not.toHaveProperty('payoutDestinationEnc');
      expect(s).not.toHaveProperty('partnerId');
      expect(JSON.stringify(s)).not.toContain('000111222333');
    }
  });
  it('never selects the destination ciphertext and carries the tenant in the WHERE', async () => {
    const stop = captureQueries();
    await listPartnerSchedules(db, 'pa');
    await getPartnerSchedule(db, 'pa', 'sa1');
    const qs = stop();
    expect(qs.length).toBe(2);
    for (const q of qs) {
      expect(q.sql).not.toContain('payout_destination_enc');
      expect(q.sql).toMatch(/"partner_id" = \$/);
      expect(q.params).toContain('pa');
    }
  });
  it('respects the row cap', async () => {
    expect((await listPartnerSchedules(db, 'pa', { limit: 1 })).map((s) => s.id)).toEqual(['sa2']);
  });
  it('requires a tenant (an empty or missing id throws, never an unscoped read)', async () => {
    await expect(listPartnerSchedules(db, '')).rejects.toThrow(/tenant/);
    await expect(listPartnerSchedules(db, undefined as never)).rejects.toThrow(/tenant/);
    await expect(getPartnerSchedule(db, '', 'sa1')).rejects.toThrow(/tenant/);
  });
});

// Scheduled-send name nudge (2026-10-02): each row says whether its owner has a legal name on file
// in THIS tenant, as a boolean computed in SQL (the name ciphertext is never selected or decrypted).
describe('needsSenderName', () => {
  const OWNER = '15550009999';
  it('true with no customer row, false once the owner has a name in this tenant', async () => {
    await createCustomerRepo(db, async () => null).ensureCustomer('pa', OWNER);
    expect((await getPartnerSchedule(db, 'pa', 'sa1'))?.needsSenderName).toBe(true);
    await createCustomerRepo(db, async () => null).setFullNameIfUnset('pa', OWNER, 'Alex Rivera');
    expect((await getPartnerSchedule(db, 'pa', 'sa1'))?.needsSenderName).toBe(false);
    expect((await listPartnerSchedules(db, 'pa')).map((s) => s.needsSenderName)).toEqual([false, false]);
  });
  it("another tenant's name does not count", async () => {
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('pb', OWNER);
    await repo.setFullNameIfUnset('pb', OWNER, 'Alex Rivera');
    expect((await getPartnerSchedule(db, 'pa', 'sa1'))?.needsSenderName).toBe(true);
    expect((await getPartnerSchedule(db, 'pb', 'sb1'))?.needsSenderName).toBe(false);
  });
  it('never returns the name or its ciphertext', async () => {
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('pa', OWNER);
    await repo.setFullNameIfUnset('pa', OWNER, 'Alex Rivera');
    const s = await getPartnerSchedule(db, 'pa', 'sa1');
    expect(JSON.stringify(s)).not.toMatch(/Rivera|full_name|fullName/);
  });
});

describe('getPartnerSchedule', () => {
  it("returns the tenant's own schedule and null for a foreign, missing or malformed id", async () => {
    expect((await getPartnerSchedule(db, 'pa', 'sa1'))?.id).toBe('sa1');
    expect(await getPartnerSchedule(db, 'pa', 'sb1')).toBeNull();
    expect(await getPartnerSchedule(db, 'pb', 'sa1')).toBeNull();
    expect(await getPartnerSchedule(db, 'pa', 'nope')).toBeNull();
    for (const bad of ['', 'a b', 'x'.repeat(200), null, 3, { id: 'sa1' }]) expect(await getPartnerSchedule(db, 'pa', bad)).toBeNull();
  });
});

describe('listPartnerRefunds', () => {
  beforeEach(async () => {
    await seedPartnerTransfer(db, { id: 'tr_ra1', partnerId: 'pa', refundStatus: 'requested' });
    await seedPartnerTransfer(db, { id: 'tr_ra2', partnerId: 'pa', refundStatus: 'failed' });
    await seedPartnerTransfer(db, { id: 'tr_ra3', partnerId: 'pa' }); // no refund: never listed
    await seedPartnerTransfer(db, { id: 'tr_rb1', partnerId: 'pb', refundStatus: 'requested' });
  });
  it("lists only the tenant's transfers with a refund, masked", async () => {
    const a = await listPartnerRefunds(db, 'pa');
    expect(a.map((t) => t.id).sort()).toEqual(['tr_ra1', 'tr_ra2']);
    for (const t of a) {
      expect(t.partnerId).toBe('pa');
      expect(t.payoutDestination.startsWith('****')).toBe(true);
      expect(t.recipientLegalName).toBeUndefined();
    }
    expect((await listPartnerRefunds(db, 'pb')).map((t) => t.id)).toEqual(['tr_rb1']);
  });
  it('requires a tenant (never the unscoped all-tenant feed)', async () => {
    await expect(listPartnerRefunds(db, '')).rejects.toThrow(/tenant/);
    await expect(listPartnerRefunds(db, undefined as never)).rejects.toThrow(/tenant/);
  });
});
