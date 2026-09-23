/**
 * Program-Fix 7 (review M1, visibility half) — a debit bound to a Stripe
 * intent that is still pending / failed after STALE_FUNDING_INTENT_DAYS can
 * be neither voided (the intent may still be confirmed) nor settled, so the
 * reconcile sweep raises ONE ops alert per row telling ops to cancel the
 * PaymentIntent in the partner's Stripe dashboard. (Server-side cancel is a
 * listed follow-up that must land before the flag is turned on.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deterministic pre-settlement re-screen (never the Redis-backed default):
// each test sets the behaviour it needs.
const rescreenMode = vi.hoisted(() => ({ value: 'cleared' as 'cleared' | 'throw' }));
vi.mock('@/lib/pay-rescreen', () => ({
  rescreenBeforePay: async (_db: unknown, t: unknown) => {
    if (rescreenMode.value === 'throw') throw new Error('screening unavailable');
    return { kind: 'cleared', transfer: t };
  },
}));
vi.mock('@/lib/store', () => ({ getStore: () => ({ getTransferDecrypted: async () => null }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({ getCustomer: async () => ({ fullName: 'Test Sender' }) }) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner: async () => null, ensureDefaultPartner: async () => ({ id: 'default' }) }) }));
import { sql } from 'drizzle-orm';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { freshDb, seedPartner } from './helpers-db';
import { reconcileSweep, STALE_FUNDING_INTENT_DAYS } from '@/lib/reconcile';
import type { Transfer } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
let repo: ReturnType<typeof createTransferRepo>;

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 195, feeUsd: 4.99, totalChargeUsd: 199.99, fxRate: 85,
    amountInr: 16575, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'acme',
    amountSource: 195, feeSource: 4.99, totalChargeSource: 199.99, ...o,
  };
}

const alerts = async () => {
  const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> }).rows;
};

beforeEach(async () => {
  rescreenMode.value = 'cleared';
  db = await freshDb();
  repo = createTransferRepo(db);
  await seedPartner(db, 'acme');
});

describe('reconcile — stale Stripe intents', () => {
  it('alerts ONCE for a bound pending/failed debit older than the threshold; fresh rows and legacy rows are silent', async () => {
    const old = new Date(Date.now() - (STALE_FUNDING_INTENT_DAYS + 1) * 86_400_000).toISOString();
    await repo.saveTransfer(makeTransfer({ id: 'old1', createdAt: old }));
    await repo.bindFundingIntent('old1', 'acme', 'stripe', 'pi_old1');
    await repo.saveTransfer(makeTransfer({ id: 'old2', createdAt: old }));
    await repo.bindFundingIntent('old2', 'acme', 'stripe', 'pi_old2');
    await repo.markFundingFailed('old2', 'acme', 'pi_old2');
    await repo.saveTransfer(makeTransfer({ id: 'fresh', createdAt: new Date().toISOString() }));
    await repo.bindFundingIntent('fresh', 'acme', 'stripe', 'pi_fresh');
    await repo.saveTransfer(makeTransfer({ id: 'legacy', createdAt: old, partnerId: 'default' })); // never bound
    await reconcileSweep(db);
    await reconcileSweep(db);
    const keys = (await alerts()).map((a) => a.dedupe_key).filter((k) => k.startsWith('fundstale:')).sort();
    expect(keys).toEqual(['fundstale:old1', 'fundstale:old2']);
    expect((await alerts()).find((a) => a.dedupe_key === 'fundstale:old1')?.payload.message).toContain('pi_old1');
  });
});

describe('reconcile — crash-resume of Stripe-funded rows (review L-a / L-b)', () => {
  async function fundedRow(id: string, o: Partial<Transfer> = {}) {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await repo.saveTransfer(makeTransfer({ id, createdAt: old, ...o }));
    await repo.bindFundingIntent(id, 'acme', 'stripe', `pi_${id}`);
    await repo.markFundingSucceeded(id, 'acme', `pi_${id}`);
  }

  it('a charged-but-BLOCKED Stripe row is not re-listed for resume every minute (its fundblocked alert already fired)', async () => {
    await fundedRow('blk');
    await repo.applyRescreenIfAwaiting('blk', 'acme', 'blocked', ['sanctions_match']);
    const listed = (await repo.listAwaitingWithFunding(10 * 60_000)).map((t) => t.id);
    expect(listed).not.toContain('blk');
  });

  it('a legacy (non-Stripe) charged-but-blocked row is STILL listed (its fundblocked alert path is unchanged)', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await repo.saveTransfer(makeTransfer({ id: 'leg', createdAt: old, partnerId: 'default', fundingRef: 'mockfund-leg', complianceStatus: 'blocked' }));
    expect((await repo.listAwaitingWithFunding(10 * 60_000)).map((t) => t.id)).toContain('leg');
  });

  it('a stripe row whose re-screen throws is left awaiting (retried next sweep), no alert', async () => {
    rescreenMode.value = 'throw';
    await fundedRow('thr');
    await reconcileSweep(db);
    expect((await repo.getTransfer('thr'))?.status).toBe('awaiting_payment');
    expect((await alerts()).map((a) => a.dedupe_key).filter((k) => k.endsWith(':thr'))).toEqual([]);
  });

  it('a stripe row whose re-screen clears is settled by the sweep with ONE fundresume alert', async () => {
    await fundedRow('clr');
    await reconcileSweep(db);
    await reconcileSweep(db);
    expect((await repo.getTransfer('clr'))?.status).toBe('paid');
    expect((await alerts()).map((a) => a.dedupe_key).filter((k) => k.endsWith(':clr'))).toEqual(['fundresume:clr']);
  });
});
