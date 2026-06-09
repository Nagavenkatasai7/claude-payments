import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ username: 'admin', role: 'admin' }),
  requireStaff: async () => ({ username: 'admin', role: 'admin' }),
  requirePlatformAdmin: async () => ({ username: 'admin', role: 'admin' }),
}));

const sharedRedis = fakeRedis();
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => actual.createPartnerStore(sharedRedis),
  };
});

vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(sharedRedis) };
});

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

beforeEach(() => sharedRedis.dump.clear());
afterEach(() => vi.clearAllMocks());

import {
  createPartnerAction,
  updatePartnerAction,
  setPartnerStatusAction,
} from '@/app/admin-dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';

const ps = createPartnerStore(sharedRedis);

describe('createPartnerAction', () => {
  it('creates a Partner with status active and a fresh id', async () => {
    const fd = new FormData();
    fd.set('name', 'Acme Remit');
    fd.append('countries', 'CA');
    await createPartnerAction(fd);
    const all = await ps.listPartners();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Acme Remit');
    expect(all[0].countries).toEqual(['CA']);
    expect(all[0].status).toBe('active');
    expect(all[0].id).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it('throws when name is empty', async () => {
    const fd = new FormData();
    fd.set('name', '');
    fd.append('countries', 'CA');
    await expect(createPartnerAction(fd)).rejects.toThrow(/name/i);
  });

  it('throws when no countries selected', async () => {
    const fd = new FormData();
    fd.set('name', 'X');
    await expect(createPartnerAction(fd)).rejects.toThrow(/country/i);
  });
});

describe('updatePartnerAction', () => {
  it('updates name + countries; preserves id/createdAt; bumps updatedAt', async () => {
    await ps.savePartner({
      id: 'p1',
      name: 'Old',
      countries: ['CA'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('name', 'Renamed');
    fd.append('countries', 'GB');
    await updatePartnerAction(fd);
    const got = await ps.getPartner('p1');
    expect(got?.name).toBe('Renamed');
    expect(got?.countries).toEqual(['GB']);
    expect(got?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(got?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });

  it('WL: persists displayName + delegated KYC mode + requireKycBeforeSend', async () => {
    await ps.savePartner({
      id: 'p2', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
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
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
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
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
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
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
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
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
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
