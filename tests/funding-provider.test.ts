import { describe, it, expect } from 'vitest';
import { MockFundingProvider, getFundingProvider } from '@/lib/providers/funding-provider';
import type { Transfer } from '@/lib/types';

const transfer = { id: 'tx_abc123' } as Transfer;

describe('MockFundingProvider', () => {
  const p = new MockFundingProvider();

  it('capture is idempotent by transfer id (deterministic ref)', async () => {
    const a = await p.capture(transfer);
    const b = await p.capture(transfer);
    expect(a.fundingRef).toBe('mockfund-tx_abc123');
    expect(b.fundingRef).toBe(a.fundingRef);
  });

  it('refund is idempotent by transfer id', async () => {
    const a = await p.refund(transfer);
    expect(a.refundRef).toBe('mockrefund-tx_abc123');
    expect((await p.refund(transfer)).refundRef).toBe(a.refundRef);
  });

  it('handleWebhook parses captured/refunded/refund_failed and ignores junk', async () => {
    expect(await p.handleWebhook({ transfer_id: 't1', event: 'captured', ref: 'r1' }))
      .toEqual({ transferId: 't1', event: 'captured', ref: 'r1' });
    expect(await p.handleWebhook({ transfer_id: 't1', event: 'refunded' }))
      .toEqual({ transferId: 't1', event: 'refunded', ref: 'mockfund-t1' });
    expect(await p.handleWebhook({ transfer_id: 't1', event: 'refund_failed' }))
      .toEqual({ transferId: 't1', event: 'refund_failed', ref: undefined });
    expect(await p.handleWebhook({ event: 'captured' })).toBeNull();
    expect(await p.handleWebhook(null)).toBeNull();
    expect(await p.handleWebhook('nope')).toBeNull();
    expect(await p.handleWebhook({ transfer_id: 't1', event: 'exploded' })).toBeNull();
  });

  it('factory returns the mock today', () => {
    expect(getFundingProvider()).toBeInstanceOf(MockFundingProvider);
  });
});
