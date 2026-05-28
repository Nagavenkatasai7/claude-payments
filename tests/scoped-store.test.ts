import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createScopedStore } from '@/lib/scoped-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createTransfer } from '@/lib/transfer-create';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Staff } from '@/lib/types';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

function platformAdmin(): Staff {
  return {
    username: 'admin', name: 'Admin', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
  };
}
function partnerStaff(partnerId: string): Staff {
  return {
    username: 'partner-' + partnerId, name: 'P', role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

async function seedTwoPartnersData(redis = fakeRedis()) {
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const partnerStore = createPartnerStore(redis);
  const scheduleStore = createScheduleStore(redis, customerStore);

  for (const id of ['acme', 'beta']) {
    await partnerStore.savePartner({
      id, name: id.toUpperCase(), countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
  }
  // 2 customers per partner
  for (const [phone, partnerId] of [
    ['15551111111', 'acme'], ['15552222222', 'acme'],
    ['15553333333', 'beta'], ['15554444444', 'beta'],
  ] as const) {
    await customerStore.saveCustomer({
      senderPhone: phone, firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified', senderCountry: 'US', partnerId,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await createTransfer(store, {
      phone, amountSource: 100, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    await scheduleStore.saveSchedule({
      id: 'SCH-' + phone, phone, amountUsd: 50,
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly', dayOfMonth: 2, status: 'active',
      createdAt: '2026-05-01T00:00:00Z',
      partnerId,
    });
  }
  // Backfill transfers to carry the correct partnerId (createTransfer always
  // writes DEFAULT_PARTNER_ID; rewrite them in-place for this test).
  for (const t of await store.listTransfers()) {
    const c = await customerStore.getCustomer(t.phone);
    await store.saveTransfer({ ...t, partnerId: c?.partnerId ?? 'default' });
  }

  return { redis, store, customerStore, partnerStore, scheduleStore };
}

describe('createScopedStore', () => {
  it('platform staff sees every partner\'s data', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(platformAdmin(), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect((await scoped.listTransfers()).length).toBe(4);
    expect((await scoped.listCustomers()).length).toBe(4);
    expect((await scoped.listSchedules()).length).toBe(4);
    expect((await scoped.listPartners()).length).toBe(2);
  });

  it('partner staff sees only their own partner\'s data', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    const transfers = await scoped.listTransfers();
    const customers = await scoped.listCustomers();
    const schedules = await scoped.listSchedules();
    const partners = await scoped.listPartners();
    expect(transfers.every((t) => t.partnerId === 'acme')).toBe(true);
    expect(transfers).toHaveLength(2);
    expect(customers.every((c) => c.partnerId === 'acme')).toBe(true);
    expect(customers).toHaveLength(2);
    expect(schedules.every((s) => s.partnerId === 'acme')).toBe(true);
    expect(schedules).toHaveLength(2);
    expect(partners.map((p) => p.id)).toEqual(['acme']);
  });

  it('partner staff getTransfer returns null for another partner\'s id', async () => {
    const env = await seedTwoPartnersData();
    const allTransfers = await env.store.listTransfers();
    const otherTransfer = allTransfers.find((t) => t.partnerId === 'beta')!;
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getTransfer(otherTransfer.id)).toBeNull();
  });

  it('partner staff getCustomer returns null for another partner\'s customer', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getCustomer('15553333333')).toBeNull();   // beta's
    expect(await scoped.getCustomer('15551111111')).not.toBeNull(); // acme's
  });

  it('partner staff getPartner returns null for another partner\'s id', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getPartner('beta')).toBeNull();
    expect((await scoped.getPartner('acme'))?.id).toBe('acme');
  });

  it('exposes the scope on the returned facade', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(scoped.scope).toEqual({ kind: 'partner', partnerId: 'acme' });
  });
});
