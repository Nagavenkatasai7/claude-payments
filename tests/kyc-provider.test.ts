import { describe, it, expect, beforeEach } from 'vitest';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

const PHONE = '15551234567';

let cs: CustomerStore;
beforeEach(async () => {
  const db = await freshDb();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
});

describe('MockKycProvider', () => {
  it('startVerification returns a URL pointing at the admin-dashboard customer page and a providerRef', async () => {
    const provider = new MockKycProvider(cs, 'https://example.com');
    const r = await provider.startVerification({ customerId: PHONE, senderPhone: PHONE });
    expect(r.url).toBe(`https://example.com/admin-dashboard/customers/${PHONE}`);
    expect(r.providerRef).toBe(`mock-${PHONE}`);
  });

  it('getStatus reads from the customer record', async () => {
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
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.getStatus('mock-unknown-phone')).toBe('pending');
  });

  it('handleWebhook always returns null (no real webhooks in mock mode)', async () => {
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.handleWebhook({ anything: true })).toBeNull();
  });
});
