import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { EnvKeyProvider } from '@/lib/field-crypto';

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ username: 'admin', role: 'admin' }),
  requireStaff: async () => ({ username: 'admin', role: 'admin' }),
  requirePlatformAdmin: async () => ({ username: 'admin', role: 'admin' }),
}));

// Partner store is Postgres-backed now; rebuilt from a fresh PGlite per test.
// The vi.mock factory closes over the let-variable (assigned in beforeEach).
let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => ps,
  };
});

// The wizard commit also writes integrations + issues the first API key —
// both Postgres-backed, rebuilt from the same PGlite per test.
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(db) };
});

// Auth store (staff/sessions) is STILL Redis.
const sharedRedis = fakeRedis();
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(sharedRedis) };
});

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

beforeEach(async () => {
  sharedRedis.dump.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
});
afterEach(() => vi.clearAllMocks());

import {
  wizardCreatePartnerAction,
  updatePartnerAction,
  setPartnerStatusAction,
} from '@/app/admin-dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';

describe('wizardCreatePartnerAction (the setup wizard commit)', () => {
  it('creates an active Partner, saves integrations, and issues a show-once API key', async () => {
    const r = await wizardCreatePartnerAction({
      name: 'Acme Remit',
      countries: ['CA'],
      kycMode: 'delegated',
      requireKycBeforeSend: true,
      payment: { providerType: 'simulator' },
    });
    const all = (await ps.listPartners()).filter((p) => p.id !== 'default');
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Acme Remit');
    expect(all[0].countries).toEqual(['CA']);
    expect(all[0].status).toBe('active');
    expect(all[0].kycMode).toBe('delegated');
    expect(r.id).toBe(all[0].id);
    // Show-once key: plaintext only in the return value, last4 matches.
    expect(r.apiKey.endsWith(r.apiKeyLast4)).toBe(true);
    // Simulator rail auto-provisioned ⇒ settlement configured.
    expect(r.settlementConfigured).toBe(true);
    expect(r.whatsappCallbackUrl).toContain(`/api/whatsapp/${r.id}`);
  });

  it('throws when name is empty', async () => {
    await expect(
      wizardCreatePartnerAction({ name: '', countries: ['CA'] }),
    ).rejects.toThrow(/name/i);
  });

  it('throws when no valid countries are given (hostile values filtered)', async () => {
    await expect(
      wizardCreatePartnerAction({ name: 'X', countries: ['ZZ'] }),
    ).rejects.toThrow(/country/i);
  });
});

describe('updatePartnerAction', () => {
  it('updates name + countries; preserves id/createdAt; bumps updatedAt', async () => {
    await ps.savePartner({
      id: 'p1',
      name: 'Old',
      countries: ['CA'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('name', 'Renamed');
    fd.append('countries', 'GB');
    await updatePartnerAction(fd);
    const got = await ps.getPartner('p1');
    expect(got?.name).toBe('Renamed');
    expect(got?.countries).toEqual(['GB']);
    expect(got?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(got?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('WL: persists displayName + delegated KYC mode + requireKycBeforeSend', async () => {
    await ps.savePartner({
      id: 'p2', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fd = new FormData();
    fd.set('id', 'p2');
    fd.set('name', 'Acme');
    fd.append('countries', 'US');
    fd.set('displayName', 'Acme Pay');
    fd.set('kycMode', 'delegated');
    fd.set('requireKycBeforeSend', 'on');
    await updatePartnerAction(fd);
    const got = await ps.getPartner('p2');
    expect(got?.displayName).toBe('Acme Pay');
    expect(got?.kycMode).toBe('delegated');
    expect(got?.requireKycBeforeSend).toBe(true);
  });

  it("WL: kycMode defaults to 'ours' and clears requireKycBeforeSend when not delegated", async () => {
    await ps.savePartner({
      id: 'p3', name: 'Bee', countries: ['US'], status: 'active',
      kycMode: 'delegated', requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fd = new FormData();
    fd.set('id', 'p3');
    fd.set('name', 'Bee');
    fd.append('countries', 'US');
    fd.set('kycMode', 'ours');
    fd.set('requireKycBeforeSend', 'on'); // ignored under 'ours'
    await updatePartnerAction(fd);
    const got = await ps.getPartner('p3');
    expect(got?.kycMode).toBe('ours');
    expect(got?.requireKycBeforeSend).toBeUndefined();
  });
});

describe('setPartnerStatusAction', () => {
  it('flips active to suspended', async () => {
    await ps.savePartner({
      id: 'p1',
      name: 'X',
      countries: ['CA'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('status', 'suspended');
    await setPartnerStatusAction(fd);
    expect((await ps.getPartner('p1'))?.status).toBe('suspended');
  });

  it('flips suspended back to active', async () => {
    await ps.savePartner({
      id: 'p1',
      name: 'X',
      countries: ['CA'],
      status: 'suspended',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('status', 'active');
    await setPartnerStatusAction(fd);
    expect((await ps.getPartner('p1'))?.status).toBe('active');
  });
});

describe('setPartnerStatusAction session revocation', () => {
  it('deletes sessions for all staff of a suspended partner', async () => {
    const { getAuthStore } = await import('@/lib/auth-store');
    const authStore = getAuthStore();
    await ps.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');

    const fd = new FormData();
    fd.set('id', 'acme');
    fd.set('status', 'suspended');
    await setPartnerStatusAction(fd);

    expect(await authStore.getSessionUser(token)).toBeNull();
  });
});
