/**
 * Program-Fix 7 (review M2) — an ACH debit can confirm up to 4 business days
 * after the pay-time re-screen, so a Stripe-funded transfer is RE-SCREENED
 * (sanctions always runs) right before it settles, on every path that settles
 * it: the webhook fast path and the reconcile crash-resume sweep.
 *   cleared → settleOrHold; flagged → settleOrHold holds it (in_review);
 *   blocked → never settled, ONE ops alert (refund in the partner's Stripe);
 *   a re-screen error → never settled (the sweep retries next minute).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { freshDb, seedPartner } from './helpers-db';
import { settleFundedTransfer } from '@/lib/stripe-funded-settle';
import { rescreenBeforePay } from '@/lib/pay-rescreen';
import { GLOBAL_DEFAULTS, LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import { setRailProviderType } from './helpers-sanctions';
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

async function funded(id: string, o: Partial<Transfer> = {}): Promise<Transfer> {
  await repo.saveTransfer(makeTransfer({ id, ...o }));
  await repo.bindFundingIntent(id, 'acme', 'stripe', `pi_${id}`);
  return (await repo.markFundingSucceeded(id, 'acme', `pi_${id}`))!;
}

const kinds = async () => {
  const r = await db.execute(sql`SELECT kind FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string }> }).rows.map((x) => x.kind);
};

beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db);
  await seedPartner(db, 'acme');
});

describe('settleFundedTransfer', () => {
  it('cleared re-screen → settles (paid + stage-1 + rail effect)', async () => {
    const t = await funded('c1');
    const r = await settleFundedTransfer(db, t, { rescreen: async (x) => ({ kind: 'cleared', transfer: x }) });
    expect(r).toBe('started');
    expect((await repo.getTransfer('c1'))?.status).toBe('paid');
  });

  it('flagged re-screen → held for review, never instructed', async () => {
    const t = await funded('f1');
    const r = await settleFundedTransfer(db, t, {
      rescreen: async (x) => {
        await repo.applyRescreenIfAwaiting(x.id, x.partnerId, 'flagged', ['sanctions_possible_match']);
        return { kind: 'flagged', transfer: (await repo.getTransfer(x.id))! };
      },
    });
    expect(r).toBe('held');
    expect((await repo.getTransfer('f1'))?.status).toBe('in_review');
    expect(await kinds()).not.toContain('mock.settle');
  });

  it('blocked re-screen → NOT settled, one ops alert', async () => {
    const t = await funded('b1');
    const block = async (x: Transfer) => {
      await repo.applyRescreenIfAwaiting(x.id, x.partnerId, 'blocked', ['sanctions_match']);
      return { kind: 'blocked' as const };
    };
    expect(await settleFundedTransfer(db, t, { rescreen: block })).toBe('blocked');
    expect(await settleFundedTransfer(db, t, { rescreen: block })).toBe('blocked');
    expect((await repo.getTransfer('b1'))?.status).toBe('awaiting_payment');
    expect(await kinds()).toEqual(['ops.alert']);
  });

  it('a re-screen that throws never settles (the sweep retries)', async () => {
    const t = await funded('e1');
    await expect(settleFundedTransfer(db, t, { rescreen: async () => { throw new Error('screen down'); } })).rejects.toThrow();
    expect((await repo.getTransfer('e1'))?.status).toBe('awaiting_payment');
    expect(await kinds()).toEqual([]);
  });

  // Fix pack 2 T3 (R02): the RAIL partner's config is read BEFORE the
  // re-screen (a failed read moves nothing), and it decides real money.
  it('the rail is read before the re-screen: an unreadable rail never re-screens', async () => {
    const t = await funded('o1');
    const calls: string[] = [];
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      await expect(
        settleFundedTransfer(db, t, { rescreen: async (x) => { calls.push('rescreen'); return { kind: 'cleared', transfer: x }; } }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
    expect(calls).toEqual([]);
  });

  it('a rail read that throws moves nothing: no screen, no status change, no outbox row', async () => {
    const t = await funded('o2');
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      await expect(settleFundedTransfer(db, t)).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
    expect((await repo.getTransfer('o2'))?.status).toBe('awaiting_payment');
    expect(await kinds()).toEqual([]);
    const screens = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'sanctions.screen'`);
    expect((screens as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
  });

  const realRescreen = (seen: boolean[]) => async (x: Transfer, opts: { realMoney: boolean }) => {
    seen.push(opts.realMoney);
    return rescreenBeforePay(db, x, { senderName: 'Alex Sender', recipientName: 'Mom' }, GLOBAL_DEFAULTS, opts);
  };

  it('http rail with a list that is not live → re-screened as real money and held', async () => {
    await setRailProviderType(db, 'acme', 'http');
    const t = await funded('h1');
    const seen: boolean[] = [];
    expect(await settleFundedTransfer(db, t, { rescreen: realRescreen(seen) })).toBe('held');
    expect(seen).toEqual([true]);
    const after = await repo.getTransfer('h1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toContain(LIST_UNAVAILABLE_REASON);
    expect(await kinds()).not.toContain('settlement.instruct');
  });

  it('mock rail → not real money, settles (started)', async () => {
    await setRailProviderType(db, 'acme', 'mock');
    const t = await funded('m1');
    const seen: boolean[] = [];
    expect(await settleFundedTransfer(db, t, { rescreen: realRescreen(seen) })).toBe('started');
    expect(seen).toEqual([false]);
  });
});
