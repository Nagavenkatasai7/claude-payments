import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Fix pack 5 T1 (P5 proof): an unsigned simulator rail is refused at pay and at
// the worker, so every writer that makes a simulator rail must mint BOTH rail
// secrets. The platform writers are savePaymentConfigAction and
// wizardCreatePartnerAction (the admin wizard UI and its fromRequest path post
// to the latter; createPartnerFromRequestAction writes no integrations; the
// partner-side writers serve http rails only). scripts/seed-demo-partners.ts
// exposes no testable function: its heal of a missing secret is a commented
// code path (fix pack 5 T1) in the script itself.

const currentStaff = { username: 'admin', role: 'admin' as const };
vi.mock('@/lib/auth', () => ({
  requireStaff: async () => currentStaff,
  requireAdmin: async () => currentStaff,
  requirePlatformAdmin: async () => currentStaff,
}));

let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => ps };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(db) };
});
const sharedRedis = fakeRedis();
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(sharedRedis) };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => sharedRedis }));
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(sharedRedis) };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import { savePaymentConfigAction, wizardCreatePartnerAction } from '@/app/admin-dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { railSecrets } from '@/lib/partner-integrations';

beforeEach(async () => {
  sharedRedis.dump.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
});
afterEach(() => vi.clearAllMocks());

async function expectBothSecrets(partnerId: string) {
  const { payment } = await createIntegrationsRepo(db).getIntegrations(partnerId);
  expect(payment.providerType).toBe('simulator');
  const now = new Date();
  expect(railSecrets(payment, 'signing', now)).toHaveLength(1);
  expect(railSecrets(payment, 'webhook', now)).toHaveLength(1);
  expect(railSecrets(payment, 'signing', now)[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(railSecrets(payment, 'webhook', now)[0]).toMatch(/^[0-9a-f]{64}$/);
}

describe('every simulator writer mints both rail secrets (pack 5 T1)', { retry: 0 }, () => {
  it("savePaymentConfigAction(providerType 'simulator') stores a non-empty signing AND webhook secret", async () => {
    await seedPartner(db, 'acme');
    const fd = new FormData();
    fd.set('id', 'acme');
    fd.set('providerType', 'simulator');
    await savePaymentConfigAction(fd);
    await expectBothSecrets('acme');
  });

  it("wizardCreatePartnerAction({ payment: { providerType: 'simulator' } }) stores a non-empty signing AND webhook secret", async () => {
    const r = await wizardCreatePartnerAction({ name: 'Sim Co', countries: ['US'], payment: { providerType: 'simulator' } });
    await expectBothSecrets(r.id);
  });
});
