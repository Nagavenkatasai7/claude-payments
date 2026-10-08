import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { finalizeLinkPayment, resolvePayableLink } from '@/lib/payment-link-finalize';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { invalidateFlagCache } from '@/lib/flags';
import { linkExpiresAt, newLinkToken } from '@/lib/payment-links';
import { SendBusyError } from '@/lib/send-limits';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B2 money path: a payment link becomes ONE transfer (claim-first). The
// owner's list: two tabs ⇒ one transfer; pay vs cancel ⇒ one winner; expired;
// pending / suspended / other-partner payee; crash and retry ⇒ one transfer;
// switch off, sends paused, not a demo phone ⇒ refused with nothing saved;
// purpose and reference copied onto the transfer.

const PHONE = '14155550100';
const RATE = () => ({ toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb', lockedAt: new Date().toISOString() });

let db: Db;
let stores: Awaited<ReturnType<typeof build>>;

async function build() {
  db = await freshDb();
  invalidateFlagCache(db);
  const redis = fakeRedis();
  const store = createStore(redis, db);
  return {
    store,
    customerStore: createCustomerStore(db, store),
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    dailyVolumeStore: createDailyVolumeStore(store),
    db,
  };
}

async function flag(key: string, enabled = true, scopeType: 'global' | 'partner' = 'global', scopeId = '') {
  await createFeatureFlagRepo(db).upsert({ key, scopeType, scopeId, enabled, reason: 'test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

async function payee(o: { id?: string; partnerId?: string; status?: 'approved' | 'pending' | 'suspended'; legalName?: string } = {}) {
  const id = o.id ?? `pye_${Math.random().toString(36).slice(2, 10)}`;
  const partnerId = o.partnerId ?? 'default';
  const repo = createPayeeRepo(db);
  await repo.insert({
    id, partnerId, legalName: o.legalName ?? 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  if ((o.status ?? 'approved') === 'approved') await repo.decide(id, ['pending'], 'approved', 'admin');
  if (o.status === 'suspended') {
    await repo.decide(id, ['pending'], 'approved', 'admin');
    await repo.decide(id, ['approved'], 'suspended', 'admin');
  }
  return id;
}

async function link(o: { payeeId: string; partnerId?: string; amountInr?: number; expiresAt?: Date; phone?: string; reference?: string }) {
  const token = newLinkToken();
  const id = `pl_${Math.random().toString(36).slice(2, 10)}`;
  await createPaymentLinkRepo(db).insertLinks([{
    id, partnerId: o.partnerId ?? 'default', payeeId: o.payeeId, token, reference: o.reference ?? `INV-${id}`,
    customerName: 'Asha Patel', customerPhone: o.phone ?? PHONE, amountInr: o.amountInr ?? 25000, purpose: 'education',
    expiresAt: o.expiresAt ?? linkExpiresAt(), createdBy: 'pa',
  }]);
  return { id, token };
}

const count = async (q: string) => Number(((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: string | number }> }).rows[0].n);
const transfersN = () => count('SELECT count(*)::int AS n FROM transfers');
const customersN = () => count(`SELECT count(*)::int AS n FROM customers WHERE phone = '${PHONE}'`);
const keysN = () => count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key LIKE 'paylink:%'`);
const linkStatus = async (id: string) =>
  ((await db.execute(sql.raw(`SELECT status, transfer_id FROM payment_links WHERE id = '${id}'`))) as unknown as { rows: Array<{ status: string; transfer_id: string | null }> }).rows[0];

const pay = (token: string, extra: Partial<Parameters<typeof finalizeLinkPayment>[1]> = {}) =>
  finalizeLinkPayment(stores, { token, fundingMethod: 'bank_transfer', rate: RATE(), ...extra });

async function expectNothingSaved(linkId: string) {
  expect(await transfersN()).toBe(0);
  expect(await keysN()).toBe(0);
  expect(await customersN()).toBe(0);
  expect((await linkStatus(linkId)).status).toBe('open');
}

beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  stores = await build();
  await flag('paylinks.enabled');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('finalizeLinkPayment', { retry: 0 }, () => {
  it('mints ONE transfer to the approved payee: exact rupees, purpose and reference copied, business recipient', async () => {
    const p = await payee();
    const l = await link({ payeeId: p, reference: 'INV-2026-001' });
    const r = await pay(l.token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = await stores.store.getTransferDecrypted(r.transferId);
    expect(t).toMatchObject({
      status: 'awaiting_payment', partnerId: 'default', phone: PHONE,
      amountInr: 25000, amountUsd: 294.12, feeUsd: 1.99, totalChargeUsd: 296.11, fxRate: 85,
      purpose: 'education', clientReference: 'INV-2026-001',
      recipientName: 'Sunrise Public School', recipientEntityType: 'business', transferType: 'b2c',
      payoutDestination: 'HDFC0001234 50100123456789', fundingMethod: 'bank_transfer',
    });
    expect(await linkStatus(l.id)).toEqual({ status: 'used', transfer_id: r.transferId });
    // Not saved into the customer's recipients; no WhatsApp opt-in recorded.
    expect(await count(`SELECT count(*)::int AS n FROM recipients WHERE sender_phone = '${PHONE}'`)).toBe(0);
    expect((await stores.customerStore.getCustomer('default', PHONE))?.optInAt).toBeFalsy();
    // The payee screen left its sanctions evidence (no names).
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = '${p}'`)).toBe(1);
  });

  it('debit card uses the $2.99 fee', async () => {
    const l = await link({ payeeId: await payee() });
    const r = await pay(l.token, { fundingMethod: 'debit_card' });
    expect(r.ok && (await stores.store.getTransfer(r.transferId))?.feeUsd).toBe(2.99);
  });

  it('two tabs paying the same link give ONE transfer', async () => {
    const l = await link({ payeeId: await payee() });
    const [a, b] = await Promise.all([pay(l.token), pay(l.token)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.transferId === b.transferId).toBe(true);
    expect(await transfersN()).toBe(1);
    expect(await keysN()).toBe(1);
  });

  it('pay and cancel at the same moment: exactly one wins', async () => {
    const l = await link({ payeeId: await payee() });
    const [paid, cancelled] = await Promise.all([pay(l.token), createPaymentLinkRepo(db).cancel('default', l.id, 'pa')]);
    const s = await linkStatus(l.id);
    if (cancelled) {
      expect(paid).toEqual({ ok: false, error: 'inactive' });
      expect(s.status).toBe('cancelled');
      expect(await transfersN()).toBe(0);
      expect(await keysN()).toBe(0);
    } else {
      expect(paid.ok).toBe(true);
      expect(s.status).toBe('used');
      expect(await transfersN()).toBe(1);
    }
  });

  it('a cancelled link cannot be paid, and a paid link cannot be cancelled', async () => {
    const p = await payee();
    const a = await link({ payeeId: p });
    expect(await createPaymentLinkRepo(db).cancel('default', a.id, 'pa')).toBe(true);
    expect(await pay(a.token)).toEqual({ ok: false, error: 'inactive' });
    const b = await link({ payeeId: p });
    expect((await pay(b.token)).ok).toBe(true);
    expect(await createPaymentLinkRepo(db).cancel('default', b.id, 'pa')).toBe(false);
  });

  it('an expired link is refused with nothing saved', async () => {
    const l = await link({ payeeId: await payee(), expiresAt: new Date(Date.now() - 1000) });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'inactive' });
    await expectNothingSaved(l.id);
  });

  it('a pending, suspended or other-partner payee is refused with nothing saved', async () => {
    await seedPartner(db, 'acme');
    for (const p of [await payee({ status: 'pending' }), await payee({ status: 'suspended' }), await payee({ partnerId: 'acme' })]) {
      const l = await link({ payeeId: p });
      expect(await pay(l.token)).toEqual({ ok: false, error: 'inactive' });
      await expectNothingSaved(l.id);
    }
  });

  it('switch off, sends paused, or not a demo phone: refused with nothing saved', async () => {
    const p = await payee();
    const l = await link({ payeeId: p });
    await flag('paylinks.enabled', false);
    expect(await pay(l.token)).toEqual({ ok: false, error: 'inactive' });
    await expectNothingSaved(l.id);

    await flag('paylinks.enabled', true);
    vi.stubEnv('DEMO_PHONES', '15550009999');
    expect(await pay(l.token)).toEqual({ ok: false, error: 'inactive' });
    await expectNothingSaved(l.id);

    vi.stubEnv('DEMO_PHONES', '*');
    await flag('sends.paused');
    expect(await pay(l.token)).toEqual({ ok: false, error: 'sends_paused' });
    await expectNothingSaved(l.id);
  });

  it('the switch can be on for one partner only', async () => {
    await flag('paylinks.enabled', false);
    await flag('paylinks.enabled', true, 'partner', 'default');
    const l = await link({ payeeId: await payee() });
    expect((await pay(l.token)).ok).toBe(true);
  });

  it('crash and retry give ONE transfer (the claimed id is re-minted)', async () => {
    const l = await link({ payeeId: await payee() });
    // The mint dies after the claim committed (lock timeout stands in for a crash).
    const spy = vi.spyOn(stores.store, 'mintUnderSenderLock').mockRejectedValueOnce(new SendBusyError());
    expect(await pay(l.token)).toEqual({ ok: false, error: 'busy' });
    expect(await transfersN()).toBe(0);
    const claimed = await linkStatus(l.id);
    expect(claimed.status).toBe('used');
    expect(await resolvePayableLink(db, stores.store, l.token)).toMatchObject({ payability: 'resume', transfer: null });
    spy.mockRestore();
    const r = await pay(l.token);
    expect(r).toEqual({ ok: true, transferId: claimed.transfer_id });
    // A third call converges on the same row.
    expect(await pay(l.token)).toEqual({ ok: true, transferId: claimed.transfer_id });
    expect(await transfersN()).toBe(1);
  });

  it('a payee that now matches the watchlist is refused at payment (nothing claimed)', async () => {
    const l = await link({ payeeId: await payee({ legalName: 'Test Blocked' }) });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'blocked' });
    expect(await keysN()).toBe(0);
    expect((await linkStatus(l.id)).status).toBe('open');
  });

  it('the $500/day first-3-days cap applies (link stays open)', async () => {
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 0 });
    const l = await link({ payeeId: await payee(), amountInr: 50000 }); // ≈ $588
    expect(await pay(l.token)).toEqual({ ok: false, error: 'cap' });
    expect((await linkStatus(l.id)).status).toBe('open');
    expect(await transfersN()).toBe(0);
  });

  it('a stale locked rate is refused before the claim', async () => {
    const l = await link({ payeeId: await payee() });
    const stale = { ...RATE(), fetchedAt: Date.now() - 2 * 3_600_000 };
    expect(await pay(l.token, { rate: stale })).toEqual({ ok: false, error: 'fx_unavailable' });
    expect((await linkStatus(l.id)).status).toBe('open');
  });

  it('the idempotency key is bound to the transfer', async () => {
    const l = await link({ payeeId: await payee() });
    const r = await pay(l.token);
    expect(r.ok && (await createIdempotencyRepo(db).find('default', `paylink:${l.id}`))).toBe(r.ok && r.transferId);
  });

  it('the customer can never change the payee account (payout locked on the pay page)', async () => {
    const l = await link({ payeeId: await payee() });
    const r = await pay(l.token);
    if (!r.ok) throw new Error('unexpected');
    const repo = createTransferRepo(db);
    expect(await repo.isPayoutEditable(r.transferId, 'default')).toBe(false);
    expect(await repo.setPayoutIfEditable(r.transferId, 'default', { payoutMethod: 'bank', payoutDestination: 'SBIN0000001 999999999' })).toBeNull();
    expect((await stores.store.getTransferDecrypted(r.transferId))?.payoutDestination).toBe('HDFC0001234 50100123456789');
  });

  it('an unknown or malformed token is inactive', async () => {
    expect(await pay('A'.repeat(22))).toEqual({ ok: false, error: 'inactive' });
    expect(await pay('../x')).toEqual({ ok: false, error: 'inactive' });
  });
});
