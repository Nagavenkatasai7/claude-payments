import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ username: 'admin', role: 'admin' }),
  requireStaff: async () => ({ username: 'admin', role: 'admin' }),
}));

const sharedRedis = fakeRedis();
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => actual.createPartnerStore(sharedRedis),
  };
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
} from '@/app/dashboard/partners/actions';
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
