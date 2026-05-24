import { describe, it, expect } from 'vitest';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';

describe('MockKycProvider', () => {
  it('startVerification returns a URL pointing at the dashboard customer page and a providerRef', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    const r = await provider.startVerification({ customerId: PHONE, senderPhone: PHONE });
    expect(r.url).toBe(`https://example.com/dashboard/customers/${PHONE}`);
    expect(r.providerRef).toBe(`mock-${PHONE}`);
  });

  it('getStatus reads from the customer record', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    await cs.upsertOnFirstInbound(PHONE);
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.getStatus(`mock-${PHONE}`)).toBe('pending'); // not_started maps to pending
    await cs.saveCustomer({
      ...(await cs.getCustomer(PHONE))!,
      kycStatus: 'verified',
    });
    expect(await provider.getStatus(`mock-${PHONE}`)).toBe('verified');
  });

  it('getStatus returns pending for unknown providerRef', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.getStatus('mock-unknown-phone')).toBe('pending');
  });

  it('handleWebhook always returns null (no real webhooks in mock mode)', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.handleWebhook({ anything: true })).toBeNull();
  });
});
