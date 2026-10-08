import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createReferralRepo } from '@/db/repos/referral-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';

// Batch B4: the referral ledger on real Postgres (PGlite). Attribution rules: first
// referral wins; a code links a NEW customer, or an EXISTING one with no delivered
// transfer and no referral yet; only an ACTIVE code of an ACTIVE referral partner counts.

let db: Db;
const PHONE = '15551230000';

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

async function seedReferralPartner(id: string, code: string, opts: { commissionCents?: number; status?: 'active' | 'inactive'; codeActive?: boolean } = {}) {
  const repo = createReferralRepo(db);
  await repo.insertPartner({ id, name: `Partner ${id}`, contact: `${id}@example.org`, commissionCents: opts.commissionCents ?? 100, createdBy: 'admin' });
  await repo.insertCode({ code, referralPartnerId: id, createdBy: 'admin' });
  if (opts.status === 'inactive') await repo.updatePartner(id, { status: 'inactive' });
  if (opts.codeActive === false) await repo.setCodeActive(code, false);
}

async function deliver(id: string, phone: string, deliveredAt: Date, partnerId = 'default', over: { refundStatus?: string } = {}) {
  await seedLedgerSpend(db, { partnerId, phone, amountUsd: 100, status: 'delivered', id, createdAt: deliveredAt });
  await db.execute(sql`UPDATE transfers SET delivered_at = ${deliveredAt.toISOString()}::timestamptz, refund_status = ${over.refundStatus ?? 'none'} WHERE id = ${id}`);
}

describe('recordAttribution', () => {
  it('a new customer with an active code is linked once (channel kept); a second code does not move them', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    await seedReferralPartner('rp_b', 'REF-BBBBBB');
    const repo = createReferralRepo(db);
    expect(await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' })).toBe(true);
    expect(await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-BBBBBB', channel: 'portal' })).toBe(false);
    expect(await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' })).toBe(false); // a redelivery
    const a = await repo.getAttribution('default', PHONE);
    expect(a).toMatchObject({ referralPartnerId: 'rp_a', referralPartnerName: 'Partner rp_a', channel: 'whatsapp', code: 'REF-AAAAAA' });
  });

  it('an existing customer with no delivered transfer is linked; one with a delivered transfer is not', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    const repo = createReferralRepo(db);
    await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000001', amountUsd: 50, status: 'paid' });
    expect(await repo.recordAttribution({ partnerId: 'default', phone: '15550000001', code: 'REF-AAAAAA', channel: 'portal' })).toBe(true);
    await deliver('tr_old', '15550000002', new Date());
    expect(await repo.recordAttribution({ partnerId: 'default', phone: '15550000002', code: 'REF-AAAAAA', channel: 'portal' })).toBe(false);
    expect(await repo.getAttribution('default', '15550000002')).toBeNull();
  });

  it('a delivered transfer under ANOTHER tenant does not block, and the attribution stays per tenant', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    const repo = createReferralRepo(db);
    await deliver('tr_acme', PHONE, new Date(), 'acme');
    expect(await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' })).toBe(true);
    expect(await repo.getAttribution('acme', PHONE)).toBeNull();
    expect(await repo.getAttribution('default', PHONE)).not.toBeNull();
  });

  it('an unknown code, an inactive code or an inactive referral partner records nothing', async () => {
    await seedReferralPartner('rp_off', 'REF-OFFOFF', { status: 'inactive' });
    await seedReferralPartner('rp_c', 'REF-CODEOF', { codeActive: false });
    const repo = createReferralRepo(db);
    for (const code of ['REF-ZZZZZZ', 'REF-OFFOFF', 'REF-CODEOF']) {
      expect(await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code, channel: 'whatsapp' }), code).toBe(false);
    }
    expect(await repo.getAttribution('default', PHONE)).toBeNull();
  });

  it('two concurrent attributions for one customer leave exactly one row', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    await seedReferralPartner('rp_b', 'REF-BBBBBB');
    const repo = createReferralRepo(db);
    const results = await Promise.all([
      repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' }),
      repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-BBBBBB', channel: 'portal' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM referral_attributions`)) as unknown as { rows: { n: number }[] };
    expect(n.rows[0].n).toBe(1);
  });
});

describe('monthlyStatement', () => {
  const SEP = new Date('2026-09-01T00:00:00Z');
  const OCT = new Date('2026-10-01T00:00:00Z');

  it('counts delivered, not refunded live transfers of referred customers in the month, times the commission', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA', { commissionCents: 150 });
    await seedReferralPartner('rp_b', 'REF-BBBBBB', { commissionCents: 0 });
    const repo = createReferralRepo(db);
    await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' });
    await repo.recordAttribution({ partnerId: 'acme', phone: '15559990000', code: 'REF-AAAAAA', channel: 'portal' });
    await deliver('t1', PHONE, new Date('2026-09-03T10:00:00Z'));
    await deliver('t2', PHONE, new Date('2026-09-20T10:00:00Z'));
    await deliver('t3', '15559990000', new Date('2026-09-21T10:00:00Z'), 'acme');
    await deliver('t4', PHONE, new Date('2026-09-22T10:00:00Z'), 'default', { refundStatus: 'completed' }); // refunded
    await deliver('t5', PHONE, new Date('2026-10-02T10:00:00Z')); // next month
    await deliver('t6', '15558887777', new Date('2026-09-05T10:00:00Z')); // not referred
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 10, status: 'paid' }); // not delivered
    const rows = await repo.monthlyStatement(SEP, OCT);
    const a = rows.find((r) => r.referralPartnerId === 'rp_a')!;
    const b = rows.find((r) => r.referralPartnerId === 'rp_b')!;
    expect(a).toMatchObject({ name: 'Partner rp_a', contact: 'rp_a@example.org', deliveredCount: 3, commissionCents: 150 });
    expect(b).toMatchObject({ deliveredCount: 0, commissionCents: 0 });
  });

  it('only for 12 months after the customer\'s first delivered transfer; sandbox rows never count', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA', { commissionCents: 100 });
    const repo = createReferralRepo(db);
    await repo.recordAttribution({ partnerId: 'default', phone: PHONE, code: 'REF-AAAAAA', channel: 'whatsapp' });
    await deliver('first', PHONE, new Date('2025-09-10T00:00:00Z'));
    await deliver('inside', PHONE, new Date('2026-09-09T23:59:00Z'));
    await deliver('outside', PHONE, new Date('2026-09-10T00:00:01Z'));
    await deliver('sandbox', PHONE, new Date('2026-09-05T00:00:00Z'));
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = 'sandbox'`);
    const rows = await repo.monthlyStatement(SEP, OCT);
    expect(rows.find((r) => r.referralPartnerId === 'rp_a')!.deliveredCount).toBe(1);
  });
});

describe('admin writes and settings', () => {
  it('updatePartner changes commission and status; listPartnersWithCodes returns codes', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    const repo = createReferralRepo(db);
    await repo.insertCode({ code: 'REF-AAAAA2', referralPartnerId: 'rp_a', createdBy: 'admin' });
    await repo.updatePartner('rp_a', { commissionCents: 250, status: 'inactive' });
    const list = await repo.listPartnersWithCodes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'rp_a', commissionCents: 250, status: 'inactive' });
    expect(list[0].codes.map((c) => c.code).sort()).toEqual(['REF-AAAAA2', 'REF-AAAAAA']);
  });

  it('the Plum URL setting is empty until set, then readable, then clearable', async () => {
    const repo = createReferralRepo(db);
    expect(await repo.getPlumPortalUrl()).toBeNull();
    await repo.setPlumPortalUrl('https://plum.example/r', 'admin');
    expect(await repo.getPlumPortalUrl()).toBe('https://plum.example/r');
    await repo.setPlumPortalUrl(null, 'admin');
    expect(await repo.getPlumPortalUrl()).toBeNull();
  });

  it('a duplicate code is refused by the primary key: insertCode answers false and keeps the first owner', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    await seedReferralPartner('rp_b', 'REF-BBBBBB');
    const repo = createReferralRepo(db);
    expect(await repo.insertCode({ code: 'REF-AAAAAA', referralPartnerId: 'rp_b', createdBy: 'admin' })).toBe(false);
    expect((await repo.getCode('REF-AAAAAA'))?.referralPartnerId).toBe('rp_a');
    expect(await repo.insertCode({ code: 'REF-AAAAA9', referralPartnerId: 'rp_b', createdBy: 'admin' })).toBe(true);
  });

  it('transfers are untouched by attribution (the tenant never changes)', async () => {
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    const id = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 10, status: 'paid' });
    await createReferralRepo(db).recordAttribution({ partnerId: 'acme', phone: PHONE, code: 'REF-AAAAAA', channel: 'portal' });
    expect((await createTransferRepo(db).getTransfer(id))!.partnerId).toBe('acme');
  });
});

describe('referredByName (customer pages)', () => {
  it("the referral partner's name for (tenant, phone); another tenant's row of the same phone is never read", async () => {
    const { referredByName } = await import('@/lib/referral-attribution');
    await seedReferralPartner('rp_a', 'REF-AAAAAA');
    await createReferralRepo(db).recordAttribution({ partnerId: 'acme', phone: '15550002222', code: 'REF-AAAAAA', channel: 'portal' });
    expect(await referredByName(() => db, 'acme', '15550002222')).toBe('Partner rp_a');
    expect(await referredByName(() => db, 'default', '15550002222')).toBeNull();
    expect(await referredByName(() => db, 'acme', '15550009999')).toBeNull();
  });

  it('a read error shows nothing (never throws)', async () => {
    const { referredByName } = await import('@/lib/referral-attribution');
    const broken = () => {
      throw new Error('db down');
    };
    expect(await referredByName(broken as never, 'acme', '15550002222')).toBeNull();
  });
});
