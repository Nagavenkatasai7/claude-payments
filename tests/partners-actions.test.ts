import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { EnvKeyProvider } from '@/lib/field-crypto';

// Mutable staff identity so individual tests can exercise the scope gates
// (reset to a platform admin in beforeEach — the historical default).
let currentStaff: { username: string; role: 'admin' | 'agent'; partnerId?: string };
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireStaff: async () => currentStaff,
  requirePlatformAdmin: async () => currentStaff,
}));

// Partner store is Postgres-backed now; rebuilt from a fresh PGlite per test.
// The vi.mock factory closes over the let-variable (assigned in beforeEach).
let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
// savePricingAction goes straight at the rate repo via getDb() — same PGlite.
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
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
  currentStaff = { username: 'admin', role: 'admin' }; // platform admin
  sharedRedis.dump.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
});
afterEach(() => vi.clearAllMocks());

import {
  wizardCreatePartnerAction,
  updatePartnerAction,
  setPartnerStatusAction,
  savePricingAction,
  saveSupportConfigAction,
  createPartnerStaffAction,
} from '@/app/admin-dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';

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

  it("WL: requireKycBeforeSend is an OPT-IN persisted in EITHER mode (and off when unchecked)", async () => {
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
    fd.set('requireKycBeforeSend', 'on'); // honored in ANY mode now
    await updatePartnerAction(fd);
    let got = await ps.getPartner('p3');
    expect(got?.kycMode).toBe('ours');
    expect(got?.requireKycBeforeSend).toBe(true);

    // Unchecking turns the gate off.
    const fd2 = new FormData();
    fd2.set('id', 'p3');
    fd2.set('name', 'Bee');
    fd2.append('countries', 'US');
    fd2.set('kycMode', 'ours');
    await updatePartnerAction(fd2);
    got = await ps.getPartner('p3');
    expect(got?.requireKycBeforeSend).toBe(false);
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

describe('savePricingAction (admin corridor margin)', () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  function marginForm(over: Record<string, string> = {}): FormData {
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('sourceCurrency', 'USD');
    fd.set('destinationCurrency', 'INR');
    fd.set('marginBps', '25');
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  }

  beforeEach(async () => {
    await ps.savePartner({
      id: 'p1', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('persists an integer margin (negative allowed) for a corridor', async () => {
    await savePricingAction(marginForm());
    let r = await createPartnerRateRepo(db).getRate('p1', 'USD', 'INR');
    expect(r?.marginBps).toBe(25);
    expect(r?.effectiveRate).toBeUndefined();

    await savePricingAction(marginForm({ marginBps: '-40' }));
    r = await createPartnerRateRepo(db).getRate('p1', 'USD', 'INR');
    expect(r?.marginBps).toBe(-40);
  });

  it('NEVER clobbers a pushed rate; an empty margin field clears the margin only', async () => {
    const repo = createPartnerRateRepo(db);
    const expiresAt = inHours(2);
    await repo.upsertRate({
      id: 'pr_push', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86.5, expiresAt, pushedAt: inHours(0),
    });

    await savePricingAction(marginForm());
    let r = await repo.getRate('p1', 'USD', 'INR');
    expect(r?.marginBps).toBe(25);
    expect(r?.effectiveRate).toBe(86.5);       // pushed rate untouched
    expect(r?.expiresAt).toBe(expiresAt);      // freshness untouched

    // Empty margin ⇒ explicit clear — still leaves the push alone.
    await savePricingAction(marginForm({ marginBps: '' }));
    r = await repo.getRate('p1', 'USD', 'INR');
    expect(r?.marginBps).toBeUndefined();
    expect(r?.effectiveRate).toBe(86.5);
  });

  it('rejects invalid input: same corridor sides, unknown currency, non-integer margin', async () => {
    await expect(
      savePricingAction(marginForm({ destinationCurrency: 'USD' })),
    ).rejects.toThrow(/differ/i);
    await expect(
      savePricingAction(marginForm({ sourceCurrency: 'ZZZ' })),
    ).rejects.toThrow(/unsupported currency/i);
    await expect(
      savePricingAction(marginForm({ marginBps: '12.5' })),
    ).rejects.toThrow(/integer/i);
    await expect(
      savePricingAction(marginForm({ marginBps: '99999' })),
    ).rejects.toThrow(/integer/i);
    expect(await createPartnerRateRepo(db).getRate('p1', 'USD', 'INR')).toBeNull();
  });

  it("scope gate: a partner-admin can set their OWN margin but another tenant's is 'not found'", async () => {
    await ps.savePartner({
      id: 'rival', name: 'Rival', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    currentStaff = { username: 'p1admin', role: 'admin', partnerId: 'p1' };
    await savePricingAction(marginForm()); // own partner — allowed
    expect((await createPartnerRateRepo(db).getRate('p1', 'USD', 'INR'))?.marginBps).toBe(25);

    await expect(
      savePricingAction(marginForm({ id: 'rival' })),
    ).rejects.toThrow(/not found/i); // generic — never discloses out-of-scope partners
    expect(await createPartnerRateRepo(db).getRate('rival', 'USD', 'INR')).toBeNull();
  });
});

describe('saveSupportConfigAction (admin support controls)', () => {
  function supportForm(over: Record<string, string> = {}): FormData {
    const fd = new FormData();
    fd.set('id', 'p1');
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  }

  beforeEach(async () => {
    await ps.savePartner({
      id: 'p1', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('persists supportConfig and round-trips both fields', async () => {
    // Unchecked box + round_robin ⇒ explicit booleans persisted.
    await saveSupportConfigAction(supportForm({ autoAssign: 'round_robin' }));
    let got = await ps.getPartner('p1');
    expect(got?.supportConfig).toEqual({ enableSupportPortal: false, autoAssign: 'round_robin' });
    expect(got?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');

    // Re-save flips back: checked + none. Unknown autoAssign falls back to 'none'.
    await saveSupportConfigAction(supportForm({ enableSupportPortal: 'on', autoAssign: 'bogus' }));
    got = await ps.getPartner('p1');
    expect(got?.supportConfig).toEqual({ enableSupportPortal: true, autoAssign: 'none' });
    expect(got?.name).toBe('Acme'); // sibling fields untouched
  });

  it("scope gate: a partner-admin saves their OWN config; another tenant's is 'not found'", async () => {
    await ps.savePartner({
      id: 'rival', name: 'Rival', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    currentStaff = { username: 'p1admin', role: 'admin', partnerId: 'p1' };
    await saveSupportConfigAction(supportForm({ enableSupportPortal: 'on' }));
    expect((await ps.getPartner('p1'))?.supportConfig?.enableSupportPortal).toBe(true);

    await expect(
      saveSupportConfigAction(supportForm({ id: 'rival', enableSupportPortal: 'on' })),
    ).rejects.toThrow(/not found/i);
    expect((await ps.getPartner('rival'))?.supportConfig).toBeUndefined();
  });
});

describe('createPartnerStaffAction roles', () => {
  function staffForm(role: string, username = 'newbie'): FormData {
    const fd = new FormData();
    fd.set('username', username);
    fd.set('name', 'New Person');
    fd.set('password', 'hunter2hunter2');
    fd.set('role', role);
    return fd;
  }

  beforeEach(async () => {
    await ps.savePartner({
      id: 'p1', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it("accepts the 'support' role and never grants it money permissions", async () => {
    await createPartnerStaffAction('p1', staffForm('support', 'p1sup'));
    const { getAuthStore } = await import('@/lib/auth-store');
    const got = await getAuthStore().getStaff('p1sup');
    expect(got?.role).toBe('support');
    expect(got?.partnerId).toBe('p1');
    expect(got?.permissions).toEqual({ canCancel: false, canResend: false, canAssign: false });
  });

  it('still rejects unknown roles', async () => {
    await expect(createPartnerStaffAction('p1', staffForm('owner'))).rejects.toThrow(/invalid role/i);
    const { getAuthStore } = await import('@/lib/auth-store');
    expect(await getAuthStore().getStaff('newbie')).toBeNull();
  });
});
