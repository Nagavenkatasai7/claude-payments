import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

// Regression for hotfix/legacy-sort-undefined:
// Smoke on 2026-05-27 (post-P2 deploy) crashed /dashboard/analytics with
//   TypeError: Cannot read properties of undefined (reading 'localeCompare')
// inside an Array.sort. The trigger is a legacy transfer in prod whose
// `createdAt` field never got populated (likely from a very early write path
// that pre-dated the current Transfer shape). listTransfers' sort comparator
// called `b.createdAt.localeCompare(a.createdAt)` and threw on it.
//
// The fix is in store.ts: coerce both operands to strings before
// localeCompare. We lock that in here so we never regress.
describe('store.listTransfers handles legacy records with missing createdAt', () => {
  it('does not throw when sorting transfers where createdAt is undefined', async () => {
    const redis = fakeRedis();
    // Two transfers, one missing createdAt entirely (simulates legacy prod data).
    await redis.set(
      'transfer:GOOD1',
      JSON.stringify({
        id: 'GOOD1',
        phone: '15551111111',
        amountUsd: 100,
        feeUsd: 1,
        totalChargeUsd: 101,
        fxRate: 85,
        amountInr: 8500,
        recipientName: 'Alice',
        recipientPhone: '919876543210',
        payoutMethod: 'upi',
        payoutDestination: 'a@upi',
        fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared',
        complianceReasons: [],
        status: 'delivered',
        createdAt: '2026-05-20T00:00:00Z',
        sourceCountry: 'US',
        sourceCurrency: 'USD',
        destinationCountry: 'IN',
        destinationCurrency: 'INR',
        partnerId: 'default',
      }),
    );
    await redis.set(
      'transfer:LEGACY1',
      // No createdAt at all — what was crashing prod.
      JSON.stringify({
        id: 'LEGACY1',
        phone: '15552222222',
        amountUsd: 50,
        feeUsd: 0,
        totalChargeUsd: 50,
        fxRate: 85,
        amountInr: 4250,
        recipientName: 'Bob',
        recipientPhone: '919876543211',
        payoutMethod: 'upi',
        payoutDestination: 'b@upi',
        fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared',
        complianceReasons: [],
        status: 'delivered',
      }),
    );
    // Insertion order matters — Timsort will call the comparator with the
    // legacy record in BOTH positions (a and b) at some point. Three items
    // forces enough comparisons that the broken path is exercised.
    await redis.sadd('transfers:ids', 'GOOD1');
    await redis.sadd('transfers:ids', 'LEGACY1');
    await redis.sadd('transfers:ids', 'GOOD2');
    await redis.set(
      'transfer:GOOD2',
      JSON.stringify({
        id: 'GOOD2',
        phone: '15553333333',
        amountUsd: 200,
        feeUsd: 2,
        totalChargeUsd: 202,
        fxRate: 85,
        amountInr: 17000,
        recipientName: 'Carol',
        recipientPhone: '919876543212',
        payoutMethod: 'upi',
        payoutDestination: 'c@upi',
        fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared',
        complianceReasons: [],
        status: 'delivered',
        createdAt: '2026-05-22T00:00:00Z',
        sourceCountry: 'US',
        sourceCurrency: 'USD',
        destinationCountry: 'IN',
        destinationCurrency: 'INR',
        partnerId: 'default',
      }),
    );

    const store = createStore(redis);
    // Before the fix this throws TypeError: Cannot read properties of undefined
    const all = await store.listTransfers();
    expect(all).toHaveLength(3);
    // Newest-first, with the field-less legacy treated as empty/oldest
    expect(all.map((t) => t.id)).toEqual(['GOOD2', 'GOOD1', 'LEGACY1']);
  });
});
