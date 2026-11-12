import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbOrTx } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Final check F9 (X2): the admin refund lists (ops page, refunds page) show the
// fixed CARD_REFUND_UNAVAILABLE line in place of Approve / Retry for a
// real-money card payment, since approveRefund / retryRefund refuse it. The flag
// is read per LISTED row that has a decision button (requested or failed), and
// only a card-class row costs a rail read.
const rail = vi.hoisted(() => ({ type: null as string | null | undefined, calls: [] as string[] }));
vi.mock('@/lib/live-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-gate')>()),
  readRailProviderType: async (_db: unknown, partnerId: string) => {
    rail.calls.push(partnerId);
    return rail.type;
  },
}));

import { cardRefundBlockedIds } from '@/lib/refund-row-flags';

const db = {} as DbOrTx;
const row = (id: string, o: Partial<Transfer> = {}) =>
  ({
    id,
    environment: 'live',
    fundingMethod: 'debit_card',
    fundingProvider: 'stripe',
    fundingRef: `pi_${id}`,
    partnerId: 'acme',
    settlementPartnerId: undefined,
    refundStatus: 'requested',
    ...o,
  }) as Transfer;

beforeEach(() => {
  rail.type = 'http';
  rail.calls = [];
});

describe('cardRefundBlockedIds (final check F9, X2)', () => {
  it('a requested or failed card row on a real-money rail is flagged', async () => {
    const ids = await cardRefundBlockedIds(db, [row('c1'), row('c2', { refundStatus: 'failed' })]);
    expect([...ids].sort()).toEqual(['c1', 'c2']);
  });

  it('a card row on a simulator rail, or a sandbox card row, is not flagged', async () => {
    rail.type = 'simulator';
    expect((await cardRefundBlockedIds(db, [row('c1')])).size).toBe(0);
    rail.type = 'http';
    expect((await cardRefundBlockedIds(db, [row('c2', { environment: 'test' })])).size).toBe(0);
  });

  it('only card-class rows with a decision button cost a rail read', async () => {
    const ids = await cardRefundBlockedIds(db, [
      row('m1', { fundingProvider: 'mock', fundingRef: 'mockfund-m1' }),
      row('p1', { fundingProvider: undefined, fundingRef: undefined, fundingMethod: 'bank_transfer' }),
      row('c3', { refundStatus: 'pending' }),
      row('c4', { refundStatus: 'completed' }),
      row('c5', { settlementPartnerId: 'railp' }),
    ]);
    expect([...ids]).toEqual(['c5']);
    expect(rail.calls).toEqual(['railp']);
  });

  it('a failed rail read flags the card row (the button hides; the core re-checks)', async () => {
    rail.type = undefined;
    expect([...(await cardRefundBlockedIds(db, [row('c6')]))]).toEqual(['c6']);
  });

  it('an empty list reads nothing', async () => {
    expect((await cardRefundBlockedIds(db, [])).size).toBe(0);
    expect(rail.calls).toEqual([]);
  });
});
