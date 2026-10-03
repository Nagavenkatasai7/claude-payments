import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants } from './helpers-partner-app';
import { listPartnerTransfers, readSenderBadges } from '@/db/repos/partner-transfer-reads';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import type { Db } from '@/db/client';

// Lost-features restore p1 B1 / B2: the tenant transfer list with search, date range and "assigned
// to me", plus the narrow sender-badge read for the tier and KYC columns. Every condition is ANDed
// with the session tenant; a search term is always a literal.

let db: Db;
const at = (iso: string) => new Date(iso).toISOString();
const ids = async (req: Parameters<typeof listPartnerTransfers>[2], partnerId = 'pa') =>
  (await listPartnerTransfers(db, partnerId, req)).items.map((t) => t.id);
const base = { limit: 25, environment: 'live' as const };

beforeEach(async () => {
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_a1', partnerId: 'pa', phone: '14155550101', recipientName: 'Asha Rao', payoutDestination: '000011112222|HDFC0001111', createdAt: at('2026-09-01T10:00:00Z'), assignedTo: 'pa-agent' });
  await seedPartnerTransfer(db, { id: 'tr_a2', partnerId: 'pa', phone: '14155559999', recipientName: 'Ravi 100%_Kumar', payoutDestination: '999988887777|SBIN0002222', createdAt: at('2026-09-02T23:59:59Z') });
  await seedPartnerTransfer(db, { id: 'tr_a3', partnerId: 'pa', phone: '447700900123', recipientName: 'Meera Iyer', payoutDestination: '555566661234', createdAt: at('2026-09-03T00:00:00Z'), status: 'delivered' });
  await seedPartnerTransfer(db, { id: 'tr_a4', partnerId: 'pa', phone: '14155550101', recipientName: 'Asha Rao', environment: 'test', createdAt: at('2026-09-03T01:00:00Z') });
  await seedPartnerTransfer(db, { id: 'tr_b1', partnerId: 'pb', phone: '14155550101', recipientName: 'Asha Rao', payoutDestination: '000011112222|HDFC0001111', createdAt: at('2026-09-01T11:00:00Z'), assignedTo: 'pa-agent' });
});

describe('listPartnerTransfers: search', () => {
  it('text: recipient name, case-insensitive, contains', async () => {
    expect(await ids({ ...base, text: 'asha' })).toEqual(['tr_a1']);
    expect(await ids({ ...base, text: 'RAO' })).toEqual(['tr_a1']);
  });
  it('text: an id prefix', async () => {
    expect(await ids({ ...base, text: 'tr_a' })).toEqual(['tr_a3', 'tr_a2', 'tr_a1']);
    expect(await ids({ ...base, text: 'r_a1' })).toEqual([]);
  });
  it('% and _ in a name are literals', async () => {
    expect(await ids({ ...base, text: '100%_K' })).toEqual(['tr_a2']);
    expect(await ids({ ...base, text: '%' })).toEqual(['tr_a2']);
    expect(await ids({ ...base, text: 'Ravi 1_0' })).toEqual([]);
  });
  it('digits: the account last 4 (exactly 4 digits) or a sender phone suffix', async () => {
    expect(await ids({ ...base, digits: '1234' })).toEqual(['tr_a3']);
    expect(await ids({ ...base, digits: '0101' })).toEqual(['tr_a1']);
    expect(await ids({ ...base, digits: '4155550101' })).toEqual(['tr_a1']);
    expect(await ids({ ...base, digits: '14155550101' })).toEqual(['tr_a1']);
    expect(await ids({ ...base, digits: '5555' })).toEqual([]);
  });
  it("never returns another tenant's matching rows", async () => {
    expect(await ids({ ...base, text: 'Asha' }, 'pb')).toEqual(['tr_b1']);
    expect(await ids({ ...base, digits: '0101' })).not.toContain('tr_b1');
  });
  it('the environment still applies', async () => {
    expect(await ids({ ...base, environment: 'test', text: 'Asha' })).toEqual(['tr_a4']);
  });
});

describe('listPartnerTransfers: dates, mine, status', () => {
  it('from is inclusive, toExclusive is exclusive (UTC days)', async () => {
    expect(await ids({ ...base, from: new Date('2026-09-02T00:00:00Z'), toExclusive: new Date('2026-09-03T00:00:00Z') })).toEqual(['tr_a2']);
    expect(await ids({ ...base, from: new Date('2026-09-03T00:00:00Z') })).toEqual(['tr_a3']);
    expect(await ids({ ...base, toExclusive: new Date('2026-09-02T00:00:00Z') })).toEqual(['tr_a1']);
  });
  it('assignedTo: only rows assigned to that user, in this tenant', async () => {
    expect(await ids({ ...base, assignedTo: 'pa-agent' })).toEqual(['tr_a1']);
    expect(await ids({ ...base, assignedTo: 'nobody' })).toEqual([]);
  });
  it('status combines with search', async () => {
    expect(await ids({ ...base, status: 'delivered', text: 'tr_a' })).toEqual(['tr_a3']);
  });
  it('keyset paging keeps the filters', async () => {
    const p1 = await listPartnerTransfers(db, 'pa', { ...base, limit: 1, text: 'tr_a' });
    expect(p1.items.map((t) => t.id)).toEqual(['tr_a3']);
    const p2 = await listPartnerTransfers(db, 'pa', { ...base, limit: 1, text: 'tr_a', cursor: p1.nextCursor });
    expect(p2.items.map((t) => t.id)).toEqual(['tr_a2']);
    const p3 = await listPartnerTransfers(db, 'pa', { ...base, limit: 1, text: 'tr_a', cursor: p2.nextCursor });
    expect(p3.items.map((t) => t.id)).toEqual(['tr_a1']);
    expect(p3.nextCursor).toBeUndefined();
  });
  it('rows stay masked', async () => {
    const [row] = (await listPartnerTransfers(db, 'pa', { ...base, text: 'Asha' })).items;
    expect(row.payoutDestination).toBe('****1111');
  });
  it('refuses a missing tenant', async () => {
    await expect(listPartnerTransfers(db, '', base)).rejects.toThrow(/tenant/);
  });
});

describe('readSenderBadges', () => {
  beforeEach(async () => {
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('pa', '14155550101');
    await repo.ensureCustomer('pb', '14155559999');
    await db.execute(sql`UPDATE customers SET kyc_status = 'verified', full_name_enc = 'v1.x.y.z.w' WHERE partner_id = 'pa' AND phone = '14155550101'`);
  });
  it("only this tenant's customers, only phone / KYC status / first seen", async () => {
    const badges = await readSenderBadges(db, 'pa', ['14155550101', '14155559999', '447700900123']);
    expect([...badges.keys()]).toEqual(['14155550101']);
    const b = badges.get('14155550101')!;
    expect(Object.keys(b).sort()).toEqual(['firstSeenAt', 'kycStatus', 'phone']);
    expect(b.kycStatus).toBe('verified');
    expect(typeof b.firstSeenAt).toBe('string');
  });
  it('no phones, no read', async () => {
    expect((await readSenderBadges(db, 'pa', [])).size).toBe(0);
  });
});
