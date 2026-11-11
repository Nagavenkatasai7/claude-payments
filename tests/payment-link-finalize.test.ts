import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
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
import { MintRefusedError } from '@/lib/transfer-create';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { certifyPartnerForTest } from './helpers-live';
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import type { Db } from '@/db/client';

// Batch B2 money path: a payment link becomes ONE transfer (claim-first). The
// owner's list: two tabs ⇒ one transfer; pay vs cancel ⇒ one winner; expired;
// pending / suspended / other-partner payee; crash and retry ⇒ one transfer;
// switch off, sends paused, not a demo phone ⇒ refused with nothing saved;
// purpose and reference copied onto the transfer.

// Fix pack 5 T22 (P21): the order of the originator write, the claim, the mint
// and the resume re-screen, and a write fault. The modules are the real ones
// (spread); the wrappers only record and, on demand, throw.
const linkSeam = vi.hoisted(() => ({ order: [] as string[], writeThrows: false }));
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return {
    ...real,
    writeOriginatorInfo: async (...a: Parameters<typeof real.writeOriginatorInfo>) => {
      linkSeam.order.push('writeOriginatorInfo');
      if (linkSeam.writeThrows) throw new TypeError('originator write failed');
      return real.writeOriginatorInfo(...a);
    },
  };
});
vi.mock('@/lib/transfer-create', async (orig) => {
  const real = await orig<typeof import('@/lib/transfer-create')>();
  return {
    ...real,
    createTransfer: async (...a: Parameters<typeof real.createTransfer>) => {
      linkSeam.order.push('createTransfer');
      return real.createTransfer(...a);
    },
  };
});
vi.mock('@/lib/pay-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-rescreen')>();
  return {
    ...real,
    rescreenBeforePay: async (...a: Parameters<typeof real.rescreenBeforePay>) => {
      linkSeam.order.push('rescreenBeforePay');
      return real.rescreenBeforePay(...a);
    },
  };
});
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createIdempotencyRepo: (...a: Parameters<typeof real.createIdempotencyRepo>) => {
      const repo = real.createIdempotencyRepo(...a);
      return {
        ...repo,
        claim: async (...c: Parameters<typeof repo.claim>) => {
          linkSeam.order.push('claim');
          return repo.claim(...c);
        },
      };
    },
  };
});

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

  it('isPaymentLinkTransfer: true for the link transfer only (the hosted pay route and page refuse it)', async () => {
    const l = await link({ payeeId: await payee() });
    const r = await pay(l.token);
    if (!r.ok) throw new Error('unexpected');
    const repo = createTransferRepo(db);
    expect(await repo.isPaymentLinkTransfer(r.transferId)).toBe(true);
    expect(await repo.isPaymentLinkTransfer('no_such_transfer')).toBe(false);
    // A transfer bound to any other claim is not a link transfer.
    await db.execute(sql.raw(`UPDATE idempotency_keys SET key = 'draft:x' WHERE transfer_id = '${r.transferId}'`));
    expect(await repo.isPaymentLinkTransfer(r.transferId)).toBe(false);
  });
});

describe('finalizeLinkPayment — a retry on the minted transfer (the charge failed before)', { retry: 0 }, () => {
  const status = async (id: string) =>
    ((await db.execute(sql.raw(`SELECT status, compliance_status, funding_ref FROM transfers WHERE id = '${id}'`))) as unknown as {
      rows: Array<{ status: string; compliance_status: string; funding_ref: string | null }>;
    }).rows[0];

  it('a sender whose KYC was rejected since the mint is refused (kyc_required), nothing charged', async () => {
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 30, kycStatus: 'verified' });
    const l = await link({ payeeId: await payee() });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    await seedSender(db, { partnerId: 'default', phone: PHONE, firstSeenDaysAgo: 30, kycStatus: 'rejected' });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'kyc_required' });
    expect(await status(first.transferId)).toEqual({ status: 'awaiting_payment', compliance_status: 'cleared', funding_ref: null });
  });

  it('a sender now on the watchlist is re-screened and blocked, never charged, evidence recorded', async () => {
    const l = await link({ payeeId: await payee() });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    const evidence = () =>
      count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = '${first.transferId}'`);
    const before = await evidence();
    const c = await stores.customerStore.getCustomer('default', PHONE);
    await stores.customerStore.saveCustomer({ ...c!, fullName: 'John Doe' });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'blocked', transferId: first.transferId });
    expect(await status(first.transferId)).toEqual({ status: 'blocked', compliance_status: 'blocked', funding_ref: null });
    expect(await evidence()).toBe(before + 1);
    // Blocked is final: the link no longer resolves as payable.
    expect(await pay(l.token)).toEqual({ ok: false, error: 'inactive' });
  });

  it('a clean retry re-screens and resumes the SAME transfer', async () => {
    const l = await link({ payeeId: await payee() });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    const evidence = () =>
      count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = '${first.transferId}'`);
    const before = await evidence();
    expect(await pay(l.token)).toEqual({ ok: true, transferId: first.transferId });
    expect(await evidence()).toBe(before + 1);
    expect(await transfersN()).toBe(1);
  });

  // Fix pack 2 T3 (R02): the resume re-screen is a real-money screen when the
  // transfer's RAIL partner (routed, else owner) is http.
  it('resumeMinted on a routed http rail with a list that is not live → flagged LIST_UNAVAILABLE (held after the charge)', async () => {
    await seedPartner(db, 'railp');
    await setRailProviderType(db, 'railp', 'http');
    const l = await link({ payeeId: await payee() });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    await db.execute(sql.raw(`UPDATE transfers SET settlement_partner_id = 'railp' WHERE id = '${first.transferId}'`));
    expect(await pay(l.token)).toEqual({ ok: true, transferId: first.transferId });
    const t = await stores.store.getTransfer(first.transferId);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.complianceStatus).toBe('flagged');
    expect(t?.complianceReasons).toContain(LIST_UNAVAILABLE_REASON);
  });

  it('a link.customerName-only mint (fullName still empty) is covered on resume and clears on a fresh list', async () => {
    // Fix pack 3 T4: a real-money link needs a certified non-default owner
    // (the default tenant on an http rail is refused before the claim).
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme');
    const original = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(original));
    const l = await link({ payeeId: await payee({ partnerId: 'acme' }), partnerId: 'acme' });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    expect((await stores.customerStore.getCustomer('acme', PHONE))?.fullName ?? '').toBe('');
    expect(await pay(l.token)).toEqual({ ok: true, transferId: first.transferId });
    expect(await status(first.transferId)).toEqual({ status: 'awaiting_payment', compliance_status: 'cleared', funding_ref: null });
  });
});

describe('finalizeLinkPayment — the payee screen on a real-money rail (fix pack 2 T3)', { retry: 0 }, () => {
  const screening = async (id: string) =>
    ((await db.execute(sql.raw(`SELECT screening FROM payees WHERE id = '${id}'`))) as unknown as { rows: Array<{ screening: string }> }).rows[0].screening;

  it('http rail, list not live → payee_unavailable, the payee keeps its screening, nothing saved', async () => {
    await setRailProviderType(db, 'default', 'http'); // the mock list is never live
    const p = await payee();
    const l = await link({ payeeId: p });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'payee_unavailable' });
    expect(await screening(p)).toBe('clear');
    await expectNothingSaved(l.id);
    // The evidence of the attempt is still recorded.
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = '${p}'`)).toBe(1);
  });

  it('payee match -> evidence + sanctions.block + notices in one tx', async () => {
    // Fix pack 2 T5 (R04).
    await setRailProviderType(db, 'default', 'http');
    const original = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(original));
    const p = await payee({ legalName: 'Testa Fixturelli' });
    const l = await link({ payeeId: p });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'blocked' });
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = '${p}'`)).toBe(1);
    const block = ((await db.execute(sql.raw(`SELECT meta FROM audit_events WHERE action = 'sanctions.block' AND subject_id = '${p}'`))) as unknown as {
      rows: Array<{ meta: Record<string, unknown> }>;
    }).rows;
    expect(block.map((r) => r.meta)).toMatchObject([{ stage: 'payee', environment: 'live', realMoney: true, quiet: false, partnerNotified: false }]);
    // The default owner is never emailed; the ops alert is queued.
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE kind = 'ops.alert' AND dedupe_key = 'sanctionsblock:${p}'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM outbox WHERE kind = 'email.send'`)).toBe(0);
    await expectNothingSaved(l.id);
  });

  it('a demo payee name on the mock rail -> a quiet audit, no alert', async () => {
    const p = await payee({ legalName: 'Test Blocked' });
    const l = await link({ payeeId: p });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'blocked' });
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.block' AND subject_id = '${p}'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM outbox`)).toBe(0);
  });

  it('a mock rail is unchanged: the mock list clears the payee and the link mints', async () => {
    await setRailProviderType(db, 'default', 'mock');
    const p = await payee();
    const l = await link({ payeeId: p });
    expect((await pay(l.token)).ok).toBe(true);
    expect(await screening(p)).toBe('clear');
  });
});

// Pack 3 T3 (contract 5): a live control refused the mint. Nothing throws
// MintRefusedError in production yet (T4 adds a PRE-claim check that keeps the
// link open; T12 throws capability_off at the mint), so the throw is stubbed
// at the sender lock, AFTER the claim. Nothing is minted or saved beyond the
// claim itself: the link is left claimed and bound to the unminted id, the
// same replay shape as a busy lock, and a retry mints that same id.
describe('finalizeLinkPayment — MintRefusedError (pack 3)', { retry: 0 }, () => {
  it.each(['live_not_certified', 'capability_off'] as const)(
    'a MintRefusedError (%s) ⇒ { ok: false, error: "not_available" }, nothing minted or saved; the claimed id re-mints',
    async (code) => {
      const l = await link({ payeeId: await payee() });
      const spy = vi.spyOn(stores.store, 'mintUnderSenderLock').mockRejectedValueOnce(new MintRefusedError(code));
      expect(await pay(l.token)).toEqual({ ok: false, error: 'not_available' });
      expect(await transfersN()).toBe(0); // (ensureCustomer runs before the claim, as on a busy lock)
      const claimed = await linkStatus(l.id);
      expect(claimed.status).toBe('used');
      expect(await resolvePayableLink(db, stores.store, l.token)).toMatchObject({ payability: 'resume', transfer: null });
      spy.mockRestore();
      expect(await pay(l.token)).toEqual({ ok: true, transferId: claimed.transfer_id });
      expect(await transfersN()).toBe(1);
    },
  );
});

// Fix pack 3 T4 (contract 5): a real-money link whose owner (the rail: a link
// mint is never routed) is not certified, or the default tenant on an http
// rail, is refused BEFORE the claim, so the link stays open and nothing is
// written. Demo rails are unchanged.
describe('finalizeLinkPayment — live certification before the claim (pack 3 T4)', { retry: 0 }, () => {
  const claimAudits = () => count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'paylink.claim'`);
  beforeEach(() => {
    const original = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 }); // the http payee screen needs a live list
    onTestFinished(() => restoreOfacSource(original));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("uncertified http link owner -> { ok: false, error: 'not_available' } BEFORE the claim: link still 'open', no idempotency claim, no paylink.claim audit row, no transfer", async () => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    const l = await link({ payeeId: await payee({ partnerId: 'acme' }), partnerId: 'acme' });
    const lock = vi.spyOn(stores.store, 'mintUnderSenderLock');
    expect(await pay(l.token)).toEqual({ ok: false, error: 'not_available' });
    await expectNothingSaved(l.id);
    expect(await claimAudits()).toBe(0);
    expect(lock).not.toHaveBeenCalled();
  });

  it("'default' owner on an http rail -> the same", async () => {
    await setRailProviderType(db, 'default', 'http');
    const l = await link({ payeeId: await payee() });
    expect(await pay(l.token)).toEqual({ ok: false, error: 'not_available' });
    await expectNothingSaved(l.id);
    expect(await claimAudits()).toBe(0);
  });

  it('certified owner -> mints as today', async () => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme');
    const l = await link({ payeeId: await payee({ partnerId: 'acme' }), partnerId: 'acme' });
    const r = await pay(l.token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await linkStatus(l.id)).toEqual({ status: 'used', transfer_id: r.transferId });
    expect(await claimAudits()).toBe(1);
  });

  it.each(['simulator', 'mock'] as const)('%s owner -> unchanged: mints', async (rail) => {
    await seedPartner(db, 'acme');
    await setRailProviderType(db, 'acme', rail);
    const l = await link({ payeeId: await payee({ partnerId: 'acme' }), partnerId: 'acme' });
    const r = await pay(l.token);
    expect(r.ok).toBe(true);
    expect(await transfersN()).toBe(1);
  });
});

// Fix pack 5 T22 (P21): the travel-rule values the link route validated are
// written on the link owner's customer AFTER ensureCustomer and the KYC gate,
// and BEFORE the claim (fresh) or the re-screen (resume). A throw answers
// 'originator_not_recorded' with nothing claimed.
describe('finalizeLinkPayment — the sender\'s address and date of birth (pack 5 T22)', { retry: 0 }, () => {
  const ADDRESS = '12 Placeholder Lane, Sampletown 00000';
  const onFile = () => createCustomerRepo(db, async () => null).originatorOnFile('default', PHONE);
  const travelAudits = async () =>
    ((await db.execute(sql.raw(`SELECT meta FROM audit_events WHERE action = 'customer.travel_rule_set'`))) as unknown as {
      rows: Array<{ meta: unknown }>;
    }).rows.map((r) => (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta));
  beforeEach(() => {
    linkSeam.order = [];
    linkSeam.writeThrows = false;
  });

  it('input.originator is written after ensureCustomer and the KYC gate, before the claim and the mint', async () => {
    const l = await link({ payeeId: await payee() });
    const r = await pay(l.token, { originator: { address: ADDRESS } });
    expect(r.ok).toBe(true);
    expect(linkSeam.order).toEqual(['writeOriginatorInfo', 'claim', 'createTransfer']);
    expect(await onFile()).toEqual({ address: true, dateOfBirth: false });
    expect(await travelAudits()).toEqual([{ source: 'payment_link', fields: ['address'], routeId: l.id }]);
  });

  it('no originator -> no write (demo links unchanged)', async () => {
    const l = await link({ payeeId: await payee() });
    expect((await pay(l.token)).ok).toBe(true);
    expect(linkSeam.order).not.toContain('writeOriginatorInfo');
    expect(await travelAudits()).toEqual([]);
  });

  it('a KYC refusal writes nothing', async () => {
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const l = await link({ payeeId: await payee() });
    expect(await pay(l.token, { originator: { address: ADDRESS } })).toEqual({ ok: false, error: 'kyc_required' });
    expect(linkSeam.order).toEqual([]);
    expect(await onFile()).toEqual({ address: false, dateOfBirth: false });
    expect(await travelAudits()).toEqual([]);
  });

  it("a throw -> { ok:false, error:'originator_not_recorded' }, no claim row, the link still open", async () => {
    linkSeam.writeThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const l = await link({ payeeId: await payee() });
    expect(await pay(l.token, { originator: { address: ADDRESS } })).toEqual({ ok: false, error: 'originator_not_recorded' });
    expect(await keysN()).toBe(0);
    expect(await transfersN()).toBe(0);
    expect((await linkStatus(l.id)).status).toBe('open');
    expect(linkSeam.order).toEqual(['writeOriginatorInfo']);
    // The log line names the error and the link only, never the value.
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('Placeholder');
  });

  it('resumeMinted writes before rescreenBeforePay (meta names the transfer); a throw never resumes', async () => {
    const l = await link({ payeeId: await payee() });
    const first = await pay(l.token);
    if (!first.ok) throw new Error(`unexpected ${first.error}`);
    linkSeam.order = [];
    linkSeam.writeThrows = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await pay(l.token, { originator: { address: ADDRESS } })).toEqual({ ok: false, error: 'originator_not_recorded' });
    expect(linkSeam.order).toEqual(['writeOriginatorInfo']);
    linkSeam.order = [];
    linkSeam.writeThrows = false;
    expect(await pay(l.token, { originator: { address: ADDRESS } })).toEqual({ ok: true, transferId: first.transferId });
    expect(linkSeam.order).toEqual(['writeOriginatorInfo', 'rescreenBeforePay']);
    expect(await travelAudits()).toEqual([
      { source: 'payment_link', fields: ['address'], transferId: first.transferId, routeId: l.id },
    ]);
    expect(await transfersN()).toBe(1);
  });
});
