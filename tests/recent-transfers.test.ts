import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { getRecentTransfersNote } from '@/lib/recent-transfers';
import type { Transfer } from '@/lib/types';

let n = 0;
function mk(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `t_${n}`, phone: '+15551230000', amountUsd: 500, feeUsd: 5, totalChargeUsd: 505,
    fxRate: 83, amountInr: 41500, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: '2026-05-28T12:00:00Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 500, feeSource: 5, totalChargeSource: 505,
    ...over,
  } as Transfer;
}

async function storeWith(...transfers: Transfer[]) {
  const store = createStore(fakeRedis());
  for (const t of transfers) await store.saveTransfer(t);
  return store;
}

describe('getRecentTransfersNote — empty-history invariant', () => {
  it('returns "" when the customer has no transfers (inject nothing)', async () => {
    const store = await storeWith(mk({ phone: '+1999', id: 'other' }));
    expect(await getRecentTransfersNote('+15551230000', store)).toBe('');
  });
  it('returns "" for a totally empty store', async () => {
    expect(await getRecentTransfersNote('+15551230000', createStore(fakeRedis()))).toBe('');
  });
});

describe('getRecentTransfersNote — own transfers only (strict phone filter)', () => {
  it("never includes another customer's transfers", async () => {
    const store = await storeWith(
      mk({ id: 'mine', recipientName: 'Mom' }),
      mk({ id: 'theirs', phone: '+1999', recipientName: 'Stranger' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('Mom');
    expect(note).not.toContain('Stranger');
  });
  it('drops a legacy record with a missing phone (fail-closed, never leaks)', async () => {
    const store = await storeWith(
      mk({ id: 'mine', recipientName: 'Mom' }),
      mk({ id: 'legacy', recipientName: 'Ghost', phone: undefined as unknown as string }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('Mom');
    expect(note).not.toContain('Ghost');
  });
});

describe('getRecentTransfersNote — caps at the newest 5', () => {
  it('a 7-transfer customer yields exactly 5 lines, the newest 5, newest-first', async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      mk({ id: `c_${i}`, recipientName: `R${i}`, createdAt: `2026-05-2${i}T00:00:00Z` }),
    );
    const store = await storeWith(...seven);
    const note = await getRecentTransfersNote('+15551230000', store);
    const lines = note.split('\n').slice(1); // drop the preamble line
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('R6'); // newest (2026-05-26) first
    expect(note).not.toContain('R1'); // 2026-05-21 fell off the cap
    expect(note).not.toContain('R0');
  });
});

describe('getRecentTransfersNote — per-line content', () => {
  it('renders date (easternDate) · recipientName · source-currency amount · status label', async () => {
    const store = await storeWith(
      mk({ recipientName: 'Mom', amountSource: 500, sourceCurrency: 'USD', status: 'delivered',
           createdAt: '2026-05-28T12:00:00Z' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('5/28/2026'); // easternDate(Date.parse(createdAt)) in ET
    expect(note).toContain('Mom');
    expect(note).toContain('$500.00');   // Intl.NumberFormat en-US USD
    expect(note).toContain('delivered');
  });
  it('renders a non-USD source currency with its own symbol', async () => {
    const store = await storeWith(
      mk({ recipientName: 'Dad', amountSource: 300, sourceCurrency: 'GBP', status: 'paid' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('£300.00');
  });
  it('maps blocked → "on hold" and NEVER the raw token', async () => {
    const store = await storeWith(mk({ recipientName: 'Ravi', status: 'blocked' }));
    const note = (await getRecentTransfersNote('+15551230000', store)).toLowerCase();
    expect(note).toContain('on hold');
    expect(note).not.toContain('blocked');
  });
  it('renders human labels for each status', async () => {
    const store = await storeWith(
      mk({ id: 'a', recipientName: 'A', status: 'awaiting_payment', createdAt: '2026-05-28T05:00:00Z' }),
      mk({ id: 'c', recipientName: 'C', status: 'cancelled',        createdAt: '2026-05-28T04:00:00Z' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('awaiting payment');
    expect(note).toContain('cancelled');
  });
});

describe('getRecentTransfersNote — defensive on missing fields', () => {
  it('never throws on missing createdAt / recipientName / sourceCurrency', async () => {
    const store = await storeWith(
      mk({ recipientName: '', createdAt: '' as unknown as string,
           sourceCurrency: undefined as unknown as Transfer['sourceCurrency'],
           amountSource: undefined as unknown as number }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('[RECENT TRANSFERS]'); // rendered, did not throw
    expect(note).toContain('a recipient');        // recipientName fallback
  });
});

describe('getRecentTransfersNote — token budget', () => {
  it('a 5-line note over long names stays within a fixed budget (6 lines, < 600 chars)', async () => {
    const long = Array.from({ length: 5 }, (_, i) =>
      mk({ id: `L_${i}`, recipientName: `Very Long Recipient Name Number ${i}`,
           createdAt: `2026-05-2${i}T00:00:00Z` }),
    );
    const store = await storeWith(...long);
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note.split('\n')).toHaveLength(6); // 1 preamble + 5 lines (cap holds)
    expect(note.length).toBeLessThan(600);
  });
});
