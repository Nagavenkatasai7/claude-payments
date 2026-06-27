import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import {
  cancelTransfer, assignTransfer, resendPaymentLink, releaseTransfer, rejectTransfer,
  issueRefund, approveRefund, dismissRefund, retryRefund, reverseB2bSettlement,
} from '@/lib/dashboard-ops';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567',
    amountUsd: 100,
    feeUsd: 2.5,
    totalChargeUsd: 102.5,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'Test User',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'test@upi',
    fundingMethod: 'credit_card',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 100,
    feeSource: 2.5,
    totalChargeSource: 102.5,
    ...overrides,
  };
}

describe('cancelTransfer', () => {
  it('sets status to cancelled for awaiting_payment', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c1', status: 'awaiting_payment' }));
    await cancelTransfer(store, 'c1');
    const loaded = await store.getTransfer('c1');
    expect(loaded?.status).toBe('cancelled');
  });

  it('sets status to cancelled for paid', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c2', status: 'paid' }));
    await cancelTransfer(store, 'c2');
    const loaded = await store.getTransfer('c2');
    expect(loaded?.status).toBe('cancelled');
  });

  it('is a no-op for delivered transfers', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c3', status: 'delivered' }));
    await cancelTransfer(store, 'c3');
    const loaded = await store.getTransfer('c3');
    expect(loaded?.status).toBe('delivered');
  });

  it('is a no-op for already cancelled transfers', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c4', status: 'cancelled' }));
    await cancelTransfer(store, 'c4');
    const loaded = await store.getTransfer('c4');
    expect(loaded?.status).toBe('cancelled');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(cancelTransfer(store, 'missing')).rejects.toThrow('Transfer not found');
  });

  it('REFUSES to bare-cancel a PAID ach_pull transfer (non-custodial guard — must use Reverse)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c5', status: 'paid', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await expect(cancelTransfer(store, 'c5')).rejects.toThrow(/use Reverse/i);
    // Status is untouched — the partner instruction is still live.
    expect((await store.getTransfer('c5'))?.status).toBe('paid');
  });

  it('still cancels an AWAITING_PAYMENT ach_pull transfer (no instruction posted yet — safe void)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c6', status: 'awaiting_payment', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await cancelTransfer(store, 'c6');
    expect((await store.getTransfer('c6'))?.status).toBe('cancelled');
  });
});

describe('reverseB2bSettlement (non-custodial partner reverse via the refund seam)', () => {
  it('paid ach_pull: flips refundStatus none→pending + enqueues funding.refund (no fundingRef needed)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rv1', status: 'paid', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await reverseB2bSettlement(db, 'rv1');
    expect((await store.getTransfer('rv1'))?.refundStatus).toBe('pending');
    expect(await outboxRows()).toEqual([{ kind: 'funding.refund', dedupe_key: 'refund:rv1' }]);
  });

  it('refuses a non-ach_pull transfer (that path uses Refund)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rv2', status: 'paid', fundingMethod: 'credit_card' }));
    await expect(reverseB2bSettlement(db, 'rv2')).rejects.toThrow(/only ACH-pull/i);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses an awaiting_payment transfer (nothing pulled to reverse) and a double-reverse', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rv3', status: 'awaiting_payment', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await expect(reverseB2bSettlement(db, 'rv3')).rejects.toThrow(/only paid or delivered/i);
    await store.saveTransfer(makeTransfer({ id: 'rv4', status: 'paid', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await reverseB2bSettlement(db, 'rv4');
    await expect(reverseB2bSettlement(db, 'rv4')).rejects.toThrow(/already in progress/i);
  });
});

describe('assignTransfer', () => {
  it('sets assignedTo and adminNote on the transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'a1' }));
    await assignTransfer(store, 'a1', 'alice@example.com', 'High priority');
    const loaded = await store.getTransfer('a1');
    expect(loaded?.assignedTo).toBe('alice@example.com');
    expect(loaded?.adminNote).toBe('High priority');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(assignTransfer(store, 'missing', 'alice', 'note')).rejects.toThrow('Transfer not found');
  });
});

describe('resendPaymentLink', () => {
  it('calls sendText with the correct phone and URL containing the transfer id', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'r1', phone: '15559876543' }));

    const sendText = vi.fn().mockResolvedValue(undefined);
    await resendPaymentLink(store, sendText, 'r1');

    expect(sendText).toHaveBeenCalledOnce();
    const [toArg, textArg] = sendText.mock.calls[0] as [string, string];
    expect(toArg).toBe('15559876543');
    expect(textArg).toContain('r1');
    expect(textArg).toContain('/pay/r1');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    const sendText = vi.fn().mockResolvedValue(undefined);
    await expect(resendPaymentLink(store, sendText, 'missing')).rejects.toThrow('Transfer not found');
  });
});

describe('releaseTransfer', () => {
  it('delivers an in_review transfer (sets status delivered, deliveredAt)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rel1', status: 'in_review', paidAt: '2026-05-30T00:00:00Z' }));
    await releaseTransfer(store, 'rel1');
    const loaded = await store.getTransfer('rel1');
    expect(loaded?.status).toBe('delivered');
    expect(loaded?.deliveredAt).toBeTruthy();
  });

  it('throws when transfer is not found', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(releaseTransfer(store, 'missing')).rejects.toThrow(/not found/i);
  });

  it('throws when transfer is not in_review (e.g. already delivered)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rel2', status: 'delivered' }));
    await expect(releaseTransfer(store, 'rel2')).rejects.toThrow(/not in_review/i);
  });

  it('throws when transfer is awaiting_payment (not yet charged)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rel3', status: 'awaiting_payment' }));
    await expect(releaseTransfer(store, 'rel3')).rejects.toThrow(/not in_review/i);
  });
});

describe('rejectTransfer', () => {
  it('cancels an UNCHARGED in_review transfer with an adminNote — and NO refund', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rej1', status: 'in_review' }));
    await rejectTransfer(store, db, 'rej1');
    const loaded = await store.getTransfer('rej1');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.adminNote).toContain('rejected in review');
    // Legacy/uncharged rows (no fundingRef) get no refund machinery.
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('AUTO-refunds a CHARGED in_review transfer: cancelled + refund pending + funding.refund row', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(
      makeTransfer({ id: 'rej_chg', status: 'in_review', fundingRef: 'mockfund-rej_chg' }),
    );
    await rejectTransfer(store, db, 'rej_chg');
    const loaded = await store.getTransfer('rej_chg');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.adminNote).toContain('rejected in review');
    expect(loaded?.refundStatus).toBe('pending');
    expect(await outboxRows()).toEqual([
      { kind: 'funding.refund', dedupe_key: 'refund:rej_chg' },
    ]);
  });

  it('throws when transfer is not found', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(rejectTransfer(store, db, 'missing')).rejects.toThrow(/not found/i);
  });

  it('throws when transfer is not in_review', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rej2', status: 'awaiting_payment' }));
    await expect(rejectTransfer(store, db, 'rej2')).rejects.toThrow(/not in_review/i);
  });

  it('throws when transfer is already cancelled (double-reject can never double-enqueue)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rej3', status: 'cancelled' }));
    await expect(rejectTransfer(store, db, 'rej3')).rejects.toThrow(/not in_review/i);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('issueRefund (admin-proactive, no prior request)', () => {
  it('moves a PAID charged transfer none → pending and enqueues one funding.refund', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'iss1', status: 'paid', fundingRef: 'mockfund-iss1',
    }));
    await issueRefund(db, 'iss1');
    expect((await store.getTransfer('iss1'))?.refundStatus).toBe('pending');
    expect(await outboxRows()).toEqual([
      { kind: 'funding.refund', dedupe_key: 'refund:iss1' },
    ]);
  });

  it('allows refunding a DELIVERED charged transfer (a clawback)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'iss2', status: 'delivered', fundingRef: 'mockfund-iss2',
    }));
    await issueRefund(db, 'iss2');
    expect((await store.getTransfer('iss2'))?.refundStatus).toBe('pending');
    expect(await outboxRows()).toHaveLength(1);
  });

  it('refuses an UNCHARGED transfer (nothing to return)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'iss3', status: 'paid' }));
    await expect(issueRefund(db, 'iss3')).rejects.toThrow(/never charged/i);
    expect((await store.getTransfer('iss3'))?.refundStatus ?? 'none').toBe('none');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses a transfer that has not been paid (e.g. awaiting_payment)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'iss4', status: 'awaiting_payment', fundingRef: 'mockfund-iss4',
    }));
    await expect(issueRefund(db, 'iss4')).rejects.toThrow(/only paid or delivered/i);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses when a refund is already in progress or complete', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'iss5', status: 'paid', fundingRef: 'f', refundStatus: 'requested',
    }));
    await expect(issueRefund(db, 'iss5')).rejects.toThrow(/already in progress or complete/i);
    expect((await store.getTransfer('iss5'))?.refundStatus).toBe('requested');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a double-issue throws on the second click and never enqueues twice', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'iss6', status: 'delivered', fundingRef: 'mockfund-iss6',
    }));
    await issueRefund(db, 'iss6');
    await expect(issueRefund(db, 'iss6')).rejects.toThrow(/already in progress or complete/i);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('throws for a missing transfer', async () => {
    await expect(issueRefund(db, 'missing')).rejects.toThrow(/not found/i);
  });
});

describe('approveRefund (customer-requested → in flight)', () => {
  it('moves requested → pending and enqueues exactly one funding.refund', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'apr1', status: 'cancelled', fundingRef: 'mockfund-apr1', refundStatus: 'requested',
    }));
    await approveRefund(db, 'apr1');
    expect((await store.getTransfer('apr1'))?.refundStatus).toBe('pending');
    expect(await outboxRows()).toEqual([
      { kind: 'funding.refund', dedupe_key: 'refund:apr1' },
    ]);
  });

  it('a double-approve throws on the second click and never enqueues twice', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'apr2', status: 'cancelled', fundingRef: 'mockfund-apr2', refundStatus: 'requested',
    }));
    await approveRefund(db, 'apr2');
    await expect(approveRefund(db, 'apr2')).rejects.toThrow(/not awaiting approval/i);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('refuses a transfer whose refund was never requested (no refund minted from thin air)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'apr3', status: 'cancelled', fundingRef: 'f' }));
    await expect(approveRefund(db, 'apr3')).rejects.toThrow(/not awaiting approval/i);
    expect((await store.getTransfer('apr3'))?.refundStatus ?? 'none').toBe('none');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('throws for a missing transfer', async () => {
    await expect(approveRefund(db, 'missing')).rejects.toThrow(/not awaiting approval/i);
  });
});

describe('dismissRefund (customer-requested → declined)', () => {
  it('moves requested → none and records an adminNote', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'dis1', status: 'cancelled', fundingRef: 'mockfund-dis1', refundStatus: 'requested',
    }));
    await dismissRefund(db, 'dis1');
    const loaded = await store.getTransfer('dis1');
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(loaded?.adminNote).toContain('refund request dismissed');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses any state but requested (in-flight refunds cannot be dismissed)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'dis2', status: 'cancelled', fundingRef: 'f', refundStatus: 'pending',
    }));
    await expect(dismissRefund(db, 'dis2')).rejects.toThrow(/not awaiting approval/i);
    expect((await store.getTransfer('dis2'))?.refundStatus).toBe('pending');
  });
});

describe('retryRefund (failed → back in flight)', () => {
  it('moves failed → pending and enqueues with a FRESH dedupe key (the original is spent)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'rty1', status: 'cancelled', fundingRef: 'mockfund-rty1', refundStatus: 'failed',
    }));
    // The original (spent) row from the first attempt is still in the outbox.
    await db.execute(sql`
      INSERT INTO outbox (kind, payload, status, dedupe_key)
      VALUES ('funding.refund', '{"transferId":"rty1"}'::jsonb, 'done', 'refund:rty1')
    `);
    await retryRefund(db, 'rty1');
    expect((await store.getTransfer('rty1'))?.refundStatus).toBe('pending');
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].kind).toBe('funding.refund');
    expect(rows[1].dedupe_key).toMatch(/^refund:rty1:retry:\d+$/);
  });

  it('refuses any state but failed (a pending refund cannot be re-enqueued)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({
      id: 'rty2', status: 'cancelled', fundingRef: 'f', refundStatus: 'pending',
    }));
    await expect(retryRefund(db, 'rty2')).rejects.toThrow(/not in a failed state/i);
    expect(await outboxRows()).toHaveLength(0);

    await store.saveTransfer(makeTransfer({ id: 'rty3', status: 'cancelled', fundingRef: 'f' }));
    await expect(retryRefund(db, 'rty3')).rejects.toThrow(/not in a failed state/i);
  });
});
