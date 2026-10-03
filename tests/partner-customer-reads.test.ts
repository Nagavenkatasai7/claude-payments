import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants } from './helpers-partner-app';
import { listPartnerCustomerTransfers, partnerCustomerTotals } from '@/db/repos/partner-customer-reads';
import type { Db } from '@/db/client';

// Lost-features p2 A10 and B4: the customer pages' ledger reads. Tenant first and required, live rows
// only, masked rows only. The same phone at another partner is a different customer.
const P1 = '14155550101';
const P2 = '14155550202';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'a1', partnerId: 'pa', phone: P1, amountUsd: 100, status: 'delivered', createdAt: ago(3 * 60_000) });
  await seedPartnerTransfer(db, { id: 'a2', partnerId: 'pa', phone: P1, amountUsd: 50, status: 'paid', createdAt: ago(2 * 60_000) });
  await seedPartnerTransfer(db, { id: 'a3', partnerId: 'pa', phone: P1, amountUsd: 30, status: 'awaiting_payment', createdAt: ago(60_000) });
  await seedPartnerTransfer(db, { id: 'a4', partnerId: 'pa', phone: P1, amountUsd: 999, status: 'cancelled', createdAt: ago(30_000) });
  await seedPartnerTransfer(db, { id: 'a5', partnerId: 'pa', phone: P1, amountUsd: 999, status: 'blocked', createdAt: ago(20_000) });
  await seedPartnerTransfer(db, { id: 'at', partnerId: 'pa', phone: P1, amountUsd: 5000, status: 'delivered', environment: 'test', createdAt: ago(10_000) });
  await seedPartnerTransfer(db, { id: 'a6', partnerId: 'pa', phone: P2, amountUsd: 10, status: 'delivered', createdAt: ago(86_400_000) });
  await seedPartnerTransfer(db, { id: 'b1', partnerId: 'pb', phone: P1, amountUsd: 7777, status: 'delivered', createdAt: ago(5_000) });
});

describe('partnerCustomerTotals', () => {
  it('requires a tenant', async () => {
    await expect(partnerCustomerTotals(db, '')).rejects.toThrow();
  });
  it('groups this tenant’s live rows by phone: count without cancelled/blocked, sent = paid + delivered', async () => {
    const m = await partnerCustomerTotals(db, 'pa');
    expect([...m.keys()].sort()).toEqual([P1, P2]);
    expect(m.get(P1)).toMatchObject({ count: 3, sentCents: 15_000 });
    expect(m.get(P2)).toMatchObject({ count: 1, sentCents: 1_000 });
    // Last activity is the newest live row (any status), never the test row or B's.
    expect(Date.parse(m.get(P1)!.lastAt)).toBeLessThan(Date.now() - 15_000);
    expect(Date.parse(m.get(P1)!.lastAt)).toBeGreaterThan(Date.now() - 25_000);
  });
  it('tenant B’s totals for the same phone are B’s only', async () => {
    const m = await partnerCustomerTotals(db, 'pb');
    expect(m.get(P1)).toMatchObject({ count: 1, sentCents: 777_700 });
    expect(m.has(P2)).toBe(false);
  });
});

describe('listPartnerCustomerTransfers', () => {
  it('requires a tenant and a phone', async () => {
    await expect(listPartnerCustomerTransfers(db, '', P1, { limit: 10 })).rejects.toThrow();
    await expect(listPartnerCustomerTransfers(db, 'pa', '', { limit: 10 })).rejects.toThrow();
  });
  it('this tenant’s live rows for the phone, newest first, masked; never B’s, never test rows', async () => {
    const page = await listPartnerCustomerTransfers(db, 'pa', P1, { limit: 10 });
    expect(page.items.map((t) => t.id)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1']);
    const json = JSON.stringify(page.items);
    expect(json).not.toContain('000011112222');
    expect(json).not.toContain('b1');
  });
  it('pages by keyset', async () => {
    const first = await listPartnerCustomerTransfers(db, 'pa', P1, { limit: 2 });
    expect(first.items.map((t) => t.id)).toEqual(['a5', 'a4']);
    expect(first.nextCursor).toBeTruthy();
    const second = await listPartnerCustomerTransfers(db, 'pa', P1, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((t) => t.id)).toEqual(['a3', 'a2']);
  });
  it('caps the page size', async () => {
    const page = await listPartnerCustomerTransfers(db, 'pa', P1, { limit: 10_000 });
    expect(page.items.length).toBeLessThanOrEqual(50);
  });
});
