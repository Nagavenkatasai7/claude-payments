import { describe, it, expect, vi } from 'vitest';
import { feeTierCount, isFirstTransferFree, STANDARD_FEE_TIER_COUNT } from '@/lib/fee-tier';

describe('fee-tier', () => {
  it('STANDARD_FEE_TIER_COUNT is 1 (a non-first transfer: the standard fee)', () => {
    expect(STANDARD_FEE_TIER_COUNT).toBe(1);
  });

  it('feeTierCount reads the store count when a phone is given', async () => {
    const getTransferCount = vi.fn(async () => 0);
    expect(await feeTierCount({ getTransferCount }, 'acme', '15551230000')).toBe(0);
    expect(getTransferCount).toHaveBeenCalledWith('acme', '15551230000');
    getTransferCount.mockResolvedValueOnce(3);
    expect(await feeTierCount({ getTransferCount }, 'acme', '15551230000')).toBe(3);
  });

  it('feeTierCount falls back to the standard count with no phone (no store read)', async () => {
    const getTransferCount = vi.fn(async () => 0);
    expect(await feeTierCount({ getTransferCount }, 'acme')).toBe(STANDARD_FEE_TIER_COUNT);
    expect(await feeTierCount({ getTransferCount }, 'acme', null)).toBe(STANDARD_FEE_TIER_COUNT);
    expect(await feeTierCount({ getTransferCount }, 'acme', '')).toBe(STANDARD_FEE_TIER_COUNT);
    expect(getTransferCount).not.toHaveBeenCalled();
  });

  it('feeTierCount propagates a store failure (callers choose their own fallback)', async () => {
    const getTransferCount = vi.fn(async () => { throw new Error('db down'); });
    await expect(feeTierCount({ getTransferCount }, 'acme', '15551230000')).rejects.toThrow('db down');
  });

  it('isFirstTransferFree is true only at count 0', () => {
    expect(isFirstTransferFree(0)).toBe(true);
    expect(isFirstTransferFree(1)).toBe(false);
    expect(isFirstTransferFree(7)).toBe(false);
  });
});
