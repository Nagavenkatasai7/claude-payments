import { describe, it, expect } from 'vitest';
import { normalizeDestination, destinationBidx, senderBidx } from '@/lib/aml-bidx';
import { deriveBlindIndexKey, blindIndex } from '@/lib/blind-index';

// Program-Fix 43: the keyed destination / sender fingerprints the AML sweep
// keeps in Redis. Variants of one destination collide; different methods and
// different purposes never do. Only HMACs leave these functions.

const key = deriveBlindIndexKey(Buffer.alloc(32, 9).toString('hex'));

describe('normalizeDestination', () => {
  it('bank: uppercases, strips whitespace / hyphens / dots, keeps the field separator', () => {
    expect(normalizeDestination('bank', ' 0000-1111 2222 | hdfc0000001 ')).toBe('bank|000011112222|HDFC0000001');
  });
  it('upi: case-insensitive, whitespace stripped, dots kept (they are significant in a VPA)', () => {
    expect(normalizeDestination('upi', ' A.B@OkHdfc ')).toBe('upi|a.b@okhdfc');
    expect(normalizeDestination('upi', 'ab@okhdfc')).not.toBe(normalizeDestination('upi', 'a.b@okhdfc'));
  });
  it('usdc: lowercased address', () => {
    expect(normalizeDestination('usdc', ' 0xABCdef ')).toBe('usdc|0xabcdef');
  });
});

describe('destinationBidx / senderBidx', () => {
  it('variants of one destination collide', () => {
    expect(destinationBidx('bank', '000011112222|HDFC0000001', key))
      .toBe(destinationBidx('bank', '0000 1111 2222 | hdfc0000001', key));
  });
  it('the same string under two methods does not collide', () => {
    expect(destinationBidx('upi', 'x@y', key)).not.toBe(destinationBidx('usdc', 'x@y', key));
  });
  it('is the payout-dest blind index of the normalized value (no plaintext)', () => {
    const b = destinationBidx('bank', '000011112222|HDFC0000001', key);
    expect(b).toBe(blindIndex('payout-dest', 'bank|000011112222|HDFC0000001', key));
    expect(b).toMatch(/^[0-9a-f]{64}$/);
  });
  it('sender key uses the aml-sender purpose, never the waitlist phone purpose', () => {
    expect(senderBidx('15550001111', key)).toBe(blindIndex('aml-sender', '15550001111', key));
    expect(senderBidx('15550001111', key)).not.toBe(blindIndex('phone', '15550001111', key));
  });
});
