import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

describe('store.getTransfer P1: lazy fill', () => {
  it('returns the 4 new fields with defaults for an old record missing them', async () => {
    const redis = fakeRedis();
    // Manually write a Transfer record from before P1 (missing the 4 new fields)
    await redis.set('transfer:OLD12345', JSON.stringify({
      id: 'OLD12345',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('OLD12345');
    expect(t?.sourceCountry).toBe('US');
    expect(t?.sourceCurrency).toBe('USD');
    expect(t?.destinationCountry).toBe('IN');
    expect(t?.destinationCurrency).toBe('INR');
  });

  it('does NOT persist the lazy fill (read paths are side-effect-free)', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLD99999', JSON.stringify({
      id: 'OLD99999',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    const store = createStore(redis);
    await store.getTransfer('OLD99999');
    const raw = await redis.get('transfer:OLD99999');
    const parsed = JSON.parse(raw!);
    expect(parsed.sourceCountry).toBeUndefined();
    expect(parsed.sourceCurrency).toBeUndefined();
    expect(parsed.destinationCountry).toBeUndefined();
    expect(parsed.destinationCurrency).toBeUndefined();
  });

  it('returns null for a missing key (unchanged behavior)', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransfer('NONE')).toBeNull();
  });

  it('returns the 4 new fields untouched when they are already present', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:NEW12345', JSON.stringify({
      id: 'NEW12345',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-05-26T00:00:00Z',
      sourceCountry: 'CA',
      sourceCurrency: 'CAD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('NEW12345');
    expect(t?.sourceCountry).toBe('CA');  // NOT overwritten by 'US' default
    expect(t?.sourceCurrency).toBe('CAD');
  });
});

describe('store.getTransfer P2: partnerId lazy fill', () => {
  it('returns partnerId: default for old records missing it', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLDP2A', JSON.stringify({
      id: 'OLDP2A',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('OLDP2A');
    expect(t?.partnerId).toBe('default');
  });

  it('does NOT persist the partnerId lazy fill', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLDP2B', JSON.stringify({
      id: 'OLDP2B',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    await store.getTransfer('OLDP2B');
    const raw = await redis.get('transfer:OLDP2B');
    expect(JSON.parse(raw!).partnerId).toBeUndefined();
  });
});

describe('store.getTransfer P4: source-currency amount lazy fill', () => {
  it('fills amountSource/feeSource/totalChargeSource from USD fields for pre-P4 records', async () => {
    const redis = fakeRedis();
    // Manually write a Transfer record from before P4 (has amountUsd/feeUsd/totalChargeUsd
    // but NO amountSource/feeSource/totalChargeSource)
    await redis.set('transfer:OLDP4A', JSON.stringify({
      id: 'OLDP4A',
      phone: '15551234567',
      amountUsd: 150,
      feeUsd: 2.49,
      totalChargeUsd: 152.49,
      fxRate: 85.2,
      amountInr: 12780,
      recipientName: 'Dad',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'dad@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      partnerId: 'default',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('OLDP4A');
    expect(t?.amountSource).toBe(150);        // equals amountUsd
    expect(t?.feeSource).toBe(2.49);          // equals feeUsd
    expect(t?.totalChargeSource).toBe(152.49); // equals totalChargeUsd
  });

  it('does NOT overwrite amountSource/feeSource/totalChargeSource when already present', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:NEWP4A', JSON.stringify({
      id: 'NEWP4A',
      phone: '15551234567',
      amountUsd: 150,
      feeUsd: 2.49,
      totalChargeUsd: 152.49,
      amountSource: 200,     // distinct from amountUsd
      feeSource: 3.99,       // distinct from feeUsd
      totalChargeSource: 203.99, // distinct from totalChargeUsd
      fxRate: 85.2,
      amountInr: 12780,
      recipientName: 'Dad',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'dad@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-05-26T00:00:00Z',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      partnerId: 'default',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('NEWP4A');
    expect(t?.amountSource).toBe(200);        // NOT overwritten by 150
    expect(t?.feeSource).toBe(3.99);          // NOT overwritten by 2.49
    expect(t?.totalChargeSource).toBe(203.99); // NOT overwritten by 152.49
  });
});
