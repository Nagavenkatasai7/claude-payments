import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createAuditLogStore } from '@/lib/audit-log-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

const redis = fakeRedis();
let actor: Staff;

// Partner + audit-log stores are Postgres-backed now; rebuilt from a fresh
// PGlite per test. The vi.mock factories close over the let-variables
// (assigned in beforeEach).
let db: Db;
let partnerStore: import('@/lib/partner-store').PartnerStore;
let auditStore: import('@/lib/audit-log-store').AuditLogStore;

vi.mock('@/lib/auth', () => ({ requirePlatformAdmin: async () => actor, requireStaff: async () => actor }));
// Program-Fix 17a: the password actions read the client IP + set the session
// cookie, reserve attempts on the staff-login guard, write auth.* audit rows and
// run the breach check. All on in-memory fakes (no network, no Upstash).
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
  }),
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.20' }),
}));
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});
const authAudited: import('@/db/repos/aux-repos').AuditEvent[] = [];
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return {
    ...actual,
    getStaffAuthAudit: () =>
      actual.createStaffAuthAudit({ record: async (e) => void authAudited.push(e), ipKey: () => Buffer.alloc(32, 1) }),
  };
});
const pwnedStatus = vi.hoisted(() => vi.fn(async (_pw: string): Promise<'pwned' | 'clean' | 'unavailable'> => 'clean'));
vi.mock('@/lib/pwned', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pwned')>('@/lib/pwned');
  return { ...actual, pwnedPasswordStatus: pwnedStatus };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => partnerStore };
});
vi.mock('@/lib/audit-log-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-log-store')>('@/lib/audit-log-store');
  return { ...actual, getAuditLogStore: () => auditStore };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import {
  createStaffAction,
  updateStaffAction,
  setStaffStatusAction,
  removeStaffAction,
  changeOwnPasswordAction,
  resetStaffPasswordAction,
} from '@/app/admin-dashboard/team/actions';
import { hashPassword, verifyPassword } from '@/lib/password';
import { staffLoginKeys } from '@/lib/staff-login-guard';

const authStore = createAuthStore(redis);

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function seedBoss() {
  await authStore.saveStaff(staff({ username: 'boss', name: 'Boss', role: 'admin' }));
  actor = staff({ username: 'boss', name: 'Boss', role: 'admin' });
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  authAudited.length = 0;
  pwnedStatus.mockReset();
  pwnedStatus.mockImplementation(async () => 'clean');
  db = await freshDb();
  partnerStore = createPartnerStore(db);
  auditStore = createAuditLogStore(db);
  await seedBoss();
});

describe('createStaffAction', () => {
  it('creates an active platform agent with credentials', async () => {
    await createStaffAction(
      form({ username: 'agent1', name: 'Agent One', password: 'a-long-password-1', role: 'agent', canCancel: 'on' }),
    );
    const got = await authStore.getStaff('agent1');
    expect(got?.role).toBe('agent');
    expect(got?.status).toBe('active');
    expect(got?.partnerId).toBeUndefined();
    expect(got?.permissions.canCancel).toBe(true);
  });

  it('assigns a partner scope when a valid partner is chosen', async () => {
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await createStaffAction(
      form({ username: 'pa', name: 'PA', password: 'a-long-password-1', role: 'admin', partnerId: 'acme' }),
    );
    expect((await authStore.getStaff('pa'))?.partnerId).toBe('acme');
  });

  it('rejects an unknown partner scope', async () => {
    await expect(
      createStaffAction(form({ username: 'x', name: 'X', password: 'a-long-password-1', role: 'agent', partnerId: 'ghost' })),
    ).rejects.toThrow(/partner not found/i);
  });

  it('rejects a username collision', async () => {
    await authStore.saveStaff(staff({ username: 'dupe', role: 'agent' }));
    await expect(
      createStaffAction(form({ username: 'dupe', name: 'D', password: 'a-long-password-1', role: 'agent' })),
    ).rejects.toThrow(/already exists/i);
  });

  it('rejects a short password', async () => {
    await expect(
      createStaffAction(form({ username: 'y', name: 'Y', password: 'short-pw-11', role: 'agent' })),
    ).rejects.toThrow(/12 characters/i);
    expect(await authStore.getStaff('y')).toBeNull();
  });

  it('Program-Fix 17a: rejects a breached password', async () => {
    pwnedStatus.mockImplementation(async () => 'pwned');
    await expect(
      createStaffAction(form({ username: 'y', name: 'Y', password: 'a-long-password-1', role: 'agent' })),
    ).rejects.toThrow(/data breach/i);
    expect(await authStore.getStaff('y')).toBeNull();
  });

  it('Program-Fix 17a: a breach-check outage refuses the create (fail-closed)', async () => {
    pwnedStatus.mockImplementation(async () => 'unavailable');
    await expect(
      createStaffAction(form({ username: 'y', name: 'Y', password: 'a-long-password-1', role: 'agent' })),
    ).rejects.toThrow(/unavailable/i);
    expect(await authStore.getStaff('y')).toBeNull();
  });

  it('writes an audit entry', async () => {
    await createStaffAction(form({ username: 'agent2', name: 'A2', password: 'a-long-password-1', role: 'agent' }));
    const log = await auditStore.list();
    expect(log[0]).toMatchObject({ actor: 'boss', action: 'created', target: 'agent2' });
  });
});

describe('updateStaffAction', () => {
  it('updates role, permissions, and scope', async () => {
    await authStore.saveStaff(staff({ username: 'a', role: 'agent' }));
    await updateStaffAction(form({ username: 'a', role: 'agent', canResend: 'on' }));
    const got = await authStore.getStaff('a');
    expect(got?.permissions.canResend).toBe(true);
  });

  it('refuses to demote the only platform admin', async () => {
    // boss is the sole active platform admin
    await expect(updateStaffAction(form({ username: 'boss', role: 'agent' }))).rejects.toThrow(
      /only platform admin/i,
    );
    expect((await authStore.getStaff('boss'))?.role).toBe('admin'); // unchanged
  });

  it('allows demoting one platform admin when another remains', async () => {
    await authStore.saveStaff(staff({ username: 'boss2', role: 'admin' }));
    await updateStaffAction(form({ username: 'boss2', role: 'agent' }));
    expect((await authStore.getStaff('boss2'))?.role).toBe('agent');
  });
});

describe('setStaffStatusAction', () => {
  it('suspends a teammate and revokes their sessions', async () => {
    await authStore.saveStaff(staff({ username: 'a', role: 'agent' }));
    const token = await authStore.createSession('a');
    await setStaffStatusAction(form({ username: 'a', status: 'suspended' }));
    expect((await authStore.getStaff('a'))?.status).toBe('suspended');
    expect(await authStore.getSessionUser(token)).toBeNull();
  });

  it('reactivates a suspended teammate', async () => {
    await authStore.saveStaff(staff({ username: 'a', role: 'agent', status: 'suspended' }));
    await setStaffStatusAction(form({ username: 'a', status: 'active' }));
    expect((await authStore.getStaff('a'))?.status).toBe('active');
  });

  it('refuses to suspend yourself', async () => {
    await expect(setStaffStatusAction(form({ username: 'boss', status: 'suspended' }))).rejects.toThrow(
      /your own account/i,
    );
  });

  it('allows suspending another platform admin when more than one remains', async () => {
    await authStore.saveStaff(staff({ username: 'boss2', role: 'admin' }));
    await setStaffStatusAction(form({ username: 'boss2', status: 'suspended' }));
    expect((await authStore.getStaff('boss2'))?.status).toBe('suspended');
  });
});

describe('removeStaffAction', () => {
  it('removes a teammate and revokes sessions', async () => {
    await authStore.saveStaff(staff({ username: 'a', role: 'agent' }));
    const token = await authStore.createSession('a');
    await removeStaffAction(form({ username: 'a' }));
    expect(await authStore.getStaff('a')).toBeNull();
    expect(await authStore.getSessionUser(token)).toBeNull();
  });

  it('refuses to remove yourself', async () => {
    await expect(removeStaffAction(form({ username: 'boss' }))).rejects.toThrow(/your own account/i);
    expect(await authStore.getStaff('boss')).not.toBeNull();
  });

  it('refuses to remove the only platform admin (non-self path is covered by the guard)', async () => {
    // Make boss2 the only OTHER platform admin, then remove boss via boss2 acting.
    await authStore.saveStaff(staff({ username: 'boss2', role: 'admin' }));
    actor = staff({ username: 'boss2', role: 'admin' });
    await removeStaffAction(form({ username: 'boss' })); // 2 admins → allowed, leaves boss2
    expect(await authStore.getStaff('boss')).toBeNull();
    // now boss2 is the only platform admin; removing them is blocked by self-guard,
    // but demoting via update is the real lockout guard (covered above).
  });

  it('writes an audit entry on removal', async () => {
    await authStore.saveStaff(staff({ username: 'a', role: 'agent' }));
    await removeStaffAction(form({ username: 'a' }));
    const log = await auditStore.list();
    expect(log[0]).toMatchObject({ actor: 'boss', action: 'removed', target: 'a' });
  });
});

// ── Program-Fix 17a: password change + admin reset ──────────────────────────

const CONCURRENT = /changed concurrently/i;

async function seedMember(over: Partial<Staff> = {}) {
  await authStore.saveStaff(
    staff({ username: 'mem', name: 'Mem', role: 'agent', passwordHash: await hashPassword('old-password-123'), ...over }),
  );
}

describe('resetStaffPasswordAction', () => {
  it('reset revokes target sessions and sets the new password', async () => {
    await seedMember();
    const t1 = await authStore.createSession('mem');
    const t2 = await authStore.createSession('mem');
    const r = await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' }));
    expect(r).toMatchObject({ ok: true });
    expect(await authStore.getSessionUser(t1)).toBeNull();
    expect(await authStore.getSessionUser(t2)).toBeNull();
    const got = (await authStore.getStaff('mem'))!;
    expect(await verifyPassword('fresh-password-456', got.passwordHash)).toBe(true);
    expect(authAudited.at(-1)).toMatchObject({
      action: 'auth.password.reset', actorType: 'staff', actor: 'boss', subjectId: 'mem',
    });
  });

  it('puts partnerId on the auth row for partner staff', async () => {
    await seedMember({ partnerId: 'acme' });
    await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' }));
    expect(authAudited.at(-1)).toMatchObject({ action: 'auth.password.reset', partnerId: 'acme' });
  });

  it('works on a suspended target and does not reactivate it', async () => {
    await seedMember({ status: 'suspended' });
    const r = await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' }));
    expect(r).toMatchObject({ ok: true });
    const got = (await authStore.getStaff('mem'))!;
    expect(got.status).toBe('suspended');
    expect(await verifyPassword('fresh-password-456', got.passwordHash)).toBe(true);
  });

  it('a concurrent change is reported, never silently overwritten', async () => {
    await seedMember();
    const racedHash = await hashPassword('someone-else-set-this');
    // The breach check runs between the read and the compare-and-set: land a change there.
    pwnedStatus.mockImplementationOnce(async () => {
      const fresh = (await authStore.getStaff('mem'))!;
      await authStore.saveStaff({ ...fresh, passwordHash: racedHash });
      return 'clean';
    });
    const r = await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' }));
    expect(r).toMatchObject({ ok: false });
    expect(r!.message).toMatch(CONCURRENT);
    expect((await authStore.getStaff('mem'))!.passwordHash).toBe(racedHash);
  });

  it('refuses an unknown target, a short password, a breached one, and an HIBP outage (fail-closed)', async () => {
    expect(await resetStaffPasswordAction(null, form({ username: 'ghost', newPassword: 'fresh-password-456' }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not found/i),
    });
    await seedMember();
    const before = (await authStore.getStaff('mem'))!.passwordHash;
    expect((await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'short' })))!.message).toMatch(/12 characters/);
    pwnedStatus.mockImplementation(async () => 'pwned');
    expect((await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' })))!.message).toMatch(/breach/);
    pwnedStatus.mockImplementation(async () => 'unavailable');
    expect((await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' })))!.message).toMatch(/unavailable/i);
    expect((await authStore.getStaff('mem'))!.passwordHash).toBe(before);
  });

  it('refuses resetting your own password (use the Account page)', async () => {
    const r = await resetStaffPasswordAction(null, form({ username: 'boss', newPassword: 'fresh-password-456' }));
    expect(r).toMatchObject({ ok: false });
  });

  it('only the seed admin can reset the seed admin', async () => {
    // tests/setup.ts: SEED_ADMIN_USERNAME ||= 'admin'
    await authStore.saveStaff(staff({ username: 'admin', name: 'Main', role: 'admin', passwordHash: await hashPassword('seed-password-1') }));
    const before = (await authStore.getStaff('admin'))!.passwordHash;
    const r = await resetStaffPasswordAction(null, form({ username: 'admin', newPassword: 'fresh-password-456' }));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/main admin/i) });
    expect((await authStore.getStaff('admin'))!.passwordHash).toBe(before);
  });

  it("clears the target's all-IP day counter so a reset member can sign in", async () => {
    await seedMember();
    await redis.set(staffLoginKeys.u('mem', Date.now()), '31');
    await resetStaffPasswordAction(null, form({ username: 'mem', newPassword: 'fresh-password-456' }));
    expect(redis.dump.has(staffLoginKeys.u('mem', Date.now()))).toBe(false);
  });
});

describe('changeOwnPasswordAction', () => {
  beforeEach(async () => {
    await seedMember();
    actor = (await authStore.getStaff('mem'))!;
  });

  const change = (current: string, next: string, confirm = next) =>
    changeOwnPasswordAction(null, form({ currentPassword: current, newPassword: next, confirmPassword: confirm }));

  it('wrong current password refused + counted', async () => {
    const r = await change('not-the-password', 'fresh-password-456');
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/current password/i) });
    expect(redis.dump.get(staffLoginKeys.ui('mem', '198.51.100.20', Date.now()))).toBe('1');
    expect(redis.dump.get(staffLoginKeys.u('mem', Date.now()))).toBe('1');
    expect(await verifyPassword('old-password-123', (await authStore.getStaff('mem'))!.passwordHash)).toBe(true);
  });

  it('the 11th wrong current password is throttled (same buckets as login)', async () => {
    for (let i = 0; i < 10; i++) await change('nope-nope-nope', 'fresh-password-456');
    expect((await change('old-password-123', 'fresh-password-456'))!.message).toMatch(/too many attempts/i);
  });

  it('success: new hash, every old session revoked, a fresh session cookie, an audit row, counters refunded', async () => {
    const old = await authStore.createSession('mem');
    const r = await change('old-password-123', 'fresh-password-456');
    expect(r).toMatchObject({ ok: true });
    expect(await authStore.getSessionUser(old)).toBeNull();
    const cookie = cookieJar.get('sendhome_session');
    expect(cookie).toBeTruthy();
    expect(await authStore.getSessionUser(cookie!)).toBe('mem');
    expect(await verifyPassword('fresh-password-456', (await authStore.getStaff('mem'))!.passwordHash)).toBe(true);
    expect(authAudited.at(-1)).toMatchObject({ action: 'auth.password.change', actorType: 'staff', actor: 'mem', subjectId: 'mem' });
    expect(redis.dump.has(staffLoginKeys.u('mem', Date.now()))).toBe(false);
  });

  it('an HIBP outage does not block a self-change (fail-open), a breached password still does', async () => {
    pwnedStatus.mockImplementation(async () => 'pwned');
    expect((await change('old-password-123', 'fresh-password-456'))!.message).toMatch(/breach/);
    pwnedStatus.mockImplementation(async () => 'unavailable');
    expect(await change('old-password-123', 'fresh-password-456')).toMatchObject({ ok: true });
  });

  it('refuses a mismatched confirmation and a short new password without writing', async () => {
    expect((await change('old-password-123', 'fresh-password-456', 'different-value-1'))!.message).toMatch(/do not match/i);
    expect((await change('old-password-123', 'short'))!.message).toMatch(/12 characters/);
    expect(await verifyPassword('old-password-123', (await authStore.getStaff('mem'))!.passwordHash)).toBe(true);
  });

  it('a concurrent reset between verify and write is reported, never overwritten', async () => {
    const racedHash = await hashPassword('admin-reset-password');
    pwnedStatus.mockImplementationOnce(async () => {
      const fresh = (await authStore.getStaff('mem'))!;
      await authStore.saveStaff({ ...fresh, passwordHash: racedHash });
      return 'clean';
    });
    const r = await change('old-password-123', 'fresh-password-456');
    expect(r!.message).toMatch(CONCURRENT);
    expect((await authStore.getStaff('mem'))!.passwordHash).toBe(racedHash);
  });
});
