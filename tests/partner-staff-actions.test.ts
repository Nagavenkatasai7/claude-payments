/**
 * Partner staff create/remove (createPartnerStaffAction / removePartnerStaffAction).
 *
 * partner-demo R5: a partner ADMIN manages their OWN tenant's staff; a platform
 * admin manages any tenant's. The REAL @/lib/auth runs here (session cookie →
 * staff record), so the gate order, the fix-17b MFA step-up and the redirects
 * are exercised, not mocked. Cross-tenant replays (OWASP authorization
 * regression) must be indistinguishable from a missing partner / member and
 * must write nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n)! } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
// Program-Fix 17b: creating/removing a member clears its MFA keys.
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
// Partner store + audit rows on a fresh PGlite per test. The audit-log-store
// singleton would otherwise keep the FIRST test's database.
let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/audit-log-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-log-store')>('@/lib/audit-log-store');
  return { ...actual, getAuditLogStore: () => actual.createAuditLogStore(db) };
});
// Program-Fix 17a: the staff password policy (breach check fail-closed). Never dial HIBP.
const pwnedStatus = vi.hoisted(() => vi.fn(async (_pw: string): Promise<'pwned' | 'clean' | 'unavailable'> => 'clean'));
vi.mock('@/lib/pwned', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pwned')>('@/lib/pwned');
  return { ...actual, pwnedPasswordStatus: pwnedStatus };
});

import { createPartnerStaffAction, removePartnerStaffAction } from '@/app/admin-dashboard/partners/actions';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { createAuditLogStore } from '@/lib/audit-log-store';
import { listTenantStaff } from '@/lib/partner-staff-policy';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { base32Decode, totpAt } from '@/lib/totp';

const PW = 'a-long-enough-password';
const NOT_FOUND = /^Partner not found\.$/;
const ENROL = 'REDIRECT:/admin-dashboard/account?enroll=1';

function member(over: Partial<Staff>): Staff {
  return {
    username: 'm',
    name: 'M',
    role: 'agent',
    permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: 'salt:hash',
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

const store = () => createAuthStore(redis);

async function signInAs(s: Staff): Promise<void> {
  await store().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await store().createSession(s.username));
}

const PLATFORM = member({ username: 'ops', role: 'admin' });
const ACME_ADMIN = member({ username: 'acme-admin', role: 'admin', partnerId: 'acme' });
const BETA_ADMIN = member({ username: 'beta-admin', role: 'admin', partnerId: 'beta' });

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

type AuditRow = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> | null };
async function auditRows(): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: AuditRow[] }).rows;
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as Error).message;
  }
}

async function enrol(username: string): Promise<void> {
  const mfa = createStaffMfaStore(redis);
  const b = await mfa.beginEnrolment(username);
  if (!b.ok) throw new Error('enrolment did not start');
  expect(await mfa.confirmEnrolment(username, totpAt(base32Decode(b.secretBase32), Date.now()))).toBe('ok');
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'acme', 'Acme');
  await seedPartner(db, 'beta', 'Beta');
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.STAFF_MFA_REQUIRED;
  delete process.env.STAFF_MFA_EXEMPT;
  delete process.env.SEED_ADMIN_USERNAME;
});

describe('createPartnerStaffAction — platform admin (unchanged behaviour)', () => {
  beforeEach(() => signInAs(PLATFORM));

  it('creates a staff record scoped to the bound partner, and audits it with the tenant', async () => {
    await createPartnerStaffAction('acme', form({ username: 'p1', name: 'Partner One', password: PW, role: 'admin' }));
    const got = await store().getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
    expect(got?.passwordHash).toMatch(/^\$pv=p0\$\$argon2id\$/); // Program-Fix 45 P4
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'ops', actor_type: 'staff', action: 'created', subject_id: 'p1' });
    expect(rows[0].meta).toMatchObject({ actorScope: 'platform' });
    expect(JSON.stringify(rows[0].meta)).not.toContain(PW);
    expect(JSON.stringify(rows[0].meta)).not.toContain('argon2');
  });

  it('ignores a partnerId in the form (the bound selector decides)', async () => {
    await createPartnerStaffAction('acme', form({ username: 'p2', name: 'P Two', password: PW, role: 'agent', partnerId: 'beta' }));
    expect((await store().getStaff('p2'))?.partnerId).toBe('acme');
  });

  it('Program-Fix 17a: refuses a short or breached password, and an HIBP outage (fail-closed), without writing', async () => {
    await expect(createPartnerStaffAction('acme', form({ username: 'p3', name: 'P3', password: 'hunter2', role: 'agent' }))).rejects.toThrow(/12 characters/);
    pwnedStatus.mockImplementationOnce(async () => 'pwned');
    await expect(createPartnerStaffAction('acme', form({ username: 'p3', name: 'P3', password: PW, role: 'agent' }))).rejects.toThrow(/breach/);
    pwnedStatus.mockImplementationOnce(async () => 'unavailable');
    await expect(createPartnerStaffAction('acme', form({ username: 'p3', name: 'P3', password: PW, role: 'agent' }))).rejects.toThrow(/unavailable/i);
    expect(await store().getStaff('p3')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('throws on an invalid role and on missing fields', async () => {
    await expect(createPartnerStaffAction('acme', form({ username: 'x', name: 'x', password: PW, role: 'root' }))).rejects.toThrow(/role/i);
    await expect(createPartnerStaffAction('acme', form({ username: '', name: 'x', password: PW, role: 'agent' }))).rejects.toThrow();
  });

  it('throws when the partner does not exist', async () => {
    await expect(createPartnerStaffAction('ghost', form({ username: 'p1', name: 'P', password: PW, role: 'agent' }))).rejects.toThrow(NOT_FOUND);
  });

  it('refuses to clobber an existing record with a generic message (no silent rebind)', async () => {
    await store().saveStaff(member({ username: 'root', role: 'admin', passwordHash: 'pre:existing' }));
    const msg = await errorOf(createPartnerStaffAction('acme', form({ username: 'root', name: 'New', password: PW, role: 'agent' })));
    expect(msg).toMatch(/choose another username/i);
    const orig = await store().getStaff('root');
    expect(orig?.partnerId).toBeUndefined();
    expect(orig?.passwordHash).toBe('pre:existing');
  });

  it('the seed admin name is never available here, even when that record is absent', async () => {
    process.env.SEED_ADMIN_USERNAME = 'owner';
    const msg = await errorOf(createPartnerStaffAction('acme', form({ username: 'owner', name: 'O', password: PW, role: 'admin' })));
    expect(msg).toMatch(/choose another username/i);
    expect(await store().getStaff('owner')).toBeNull();
  });

  it('MFA trap (fix 17b): with STAFF_MFA_REQUIRED on, an unenrolled platform admin is still sent to enrol, and nothing is written', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await store().saveStaff(member({ username: 'acme-agent', partnerId: 'acme' }));
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'p9', name: 'P', password: PW, role: 'agent' })))).toBe(ENROL);
    expect(await errorOf(removePartnerStaffAction(form({ username: 'acme-agent' })))).toBe(ENROL);
    expect(await store().getStaff('p9')).toBeNull();
    expect(await store().getStaff('acme-agent')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });
});

describe('createPartnerStaffAction — partner admin (R5)', () => {
  beforeEach(() => signInAs(ACME_ADMIN));

  it('creates an agent in their own tenant, audited with partner_id and actorScope partner', async () => {
    await createPartnerStaffAction('acme', form({ username: 'acme-agent', name: 'Agent', password: PW, role: 'agent' }));
    const got = await store().getStaff('acme-agent');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('agent');
    expect(got?.permissions).toEqual({ canCancel: false, canResend: false, canAssign: false, canRevealPii: false });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', action: 'created', subject_id: 'acme-agent' });
    expect(rows[0].meta).toMatchObject({ actorScope: 'partner' });
  });

  it('role=admin plus a forged partnerId never yields a platform account (a tenant-pinned admin at most)', async () => {
    await createPartnerStaffAction('acme', form({ username: 'acme-admin-2', name: 'A2', password: PW, role: 'admin', partnerId: '' }));
    const got = await store().getStaff('acme-admin-2');
    expect(got?.role).toBe('admin');
    expect(got?.partnerId).toBe('acme');
  });

  it('cannot escalate its own role: its own username collides generically and its record is unchanged', async () => {
    const msg = await errorOf(createPartnerStaffAction('acme', form({ username: 'acme-admin', name: 'Me', password: PW, role: 'admin' })));
    expect(msg).toMatch(/choose another username/i);
    const me = await store().getStaff('acme-admin');
    expect(me?.partnerId).toBe('acme');
    expect(me?.passwordHash).toBe('salt:hash');
    expect(await auditRows()).toEqual([]);
  });

  it('cross-tenant replay: another tenant\'s id is refused exactly like a missing partner, before any validation, and writes nothing', async () => {
    const other = await errorOf(createPartnerStaffAction('beta', form({ username: 'x1', name: 'X', password: PW, role: 'agent' })));
    const missing = await errorOf(createPartnerStaffAction('nope', form({ username: 'x1', name: 'X', password: PW, role: 'agent' })));
    const otherInvalid = await errorOf(createPartnerStaffAction('beta', form({ username: '', name: '', password: '', role: 'root' })));
    expect(other).toMatch(NOT_FOUND);
    expect(missing).toBe(other);
    expect(otherInvalid).toBe(other);
    // a platform-style empty selector is refused the same way
    expect(await errorOf(createPartnerStaffAction('', form({ username: 'x1', name: 'X', password: PW, role: 'admin' })))).toBe(other);
    expect(await store().getStaff('x1')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('with STAFF_MFA_REQUIRED on, an unenrolled partner admin is sent to enrol (same policy as platform), then passes once enrolled', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'g1', name: 'G', password: PW, role: 'agent' })))).toBe(ENROL);
    expect(await store().getStaff('g1')).toBeNull();
    await enrol('acme-admin');
    await createPartnerStaffAction('acme', form({ username: 'g1', name: 'G', password: PW, role: 'agent' }));
    expect((await store().getStaff('g1'))?.partnerId).toBe('acme');
  });

  it('flag off (default): no MFA requirement for the partner admin', async () => {
    await createPartnerStaffAction('acme', form({ username: 'g2', name: 'G', password: PW, role: 'agent' }));
    expect(await store().getStaff('g2')).not.toBeNull();
  });

  it('a new member starts with no MFA enrolment left over from a re-used name', async () => {
    await enrol('reuse');
    await createPartnerStaffAction('acme', form({ username: 'reuse', name: 'R', password: PW, role: 'agent' }));
    expect(await createStaffMfaStore(redis).isEnrolled('reuse')).toBe(false);
  });

  it('creates are rate-limited per actor', async () => {
    let refused = '';
    for (let i = 0; i < 25 && !refused; i++) {
      const msg = await errorOf(createPartnerStaffAction('acme', form({ username: `bulk${i}`, name: 'B', password: PW, role: 'agent' })));
      if (msg !== 'OK') refused = msg;
    }
    expect(refused).toMatch(/too many/i);
  });
});

describe('createPartnerStaffAction — non-admin actors', () => {
  it.each(['agent', 'support'] as const)('a partner %s is redirected and writes nothing', async (role) => {
    await signInAs(member({ username: `acme-${role}`, role, partnerId: 'acme' }));
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'z', name: 'Z', password: PW, role: 'agent' })))).toBe('REDIRECT:/admin-dashboard');
    expect(await store().getStaff('z')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('no session → sent to login', async () => {
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'z', name: 'Z', password: PW, role: 'agent' })))).toBe('REDIRECT:/login');
  });
});

describe('removePartnerStaffAction', () => {
  const ACME_AGENT = member({ username: 'acme-agent', partnerId: 'acme' });

  it('platform admin: deletes the record, its sessions and MFA, and audits it with the tenant', async () => {
    await signInAs(PLATFORM);
    await store().saveStaff(ACME_AGENT);
    const token = await store().createSession('acme-agent');
    await enrol('acme-agent');
    await removePartnerStaffAction(form({ username: 'acme-agent' }));
    expect(await store().getStaff('acme-agent')).toBeNull();
    expect(await store().getSessionUser(token)).toBeNull();
    expect(await createStaffMfaStore(redis).isEnrolled('acme-agent')).toBe(false);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'ops', action: 'removed', subject_id: 'acme-agent' });
  });

  it('platform admin: a platform account is still refused here (Team page only)', async () => {
    await signInAs(PLATFORM);
    await store().saveStaff(member({ username: 'root', role: 'admin' }));
    await expect(removePartnerStaffAction(form({ username: 'root' }))).rejects.toThrow(/Team page/);
    expect(await store().getStaff('root')).not.toBeNull();
  });

  it('platform admin: the tenant\'s last active admin cannot be removed', async () => {
    await signInAs(PLATFORM);
    await store().saveStaff(member({ username: 'acme-only', role: 'admin', partnerId: 'acme' }));
    await expect(removePartnerStaffAction(form({ username: 'acme-only' }))).rejects.toThrow(/only admin/i);
    expect(await store().getStaff('acme-only')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('partner admin: removes a member of their own tenant, audited with the tenant', async () => {
    await signInAs(ACME_ADMIN);
    await store().saveStaff(ACME_AGENT);
    await removePartnerStaffAction(form({ username: 'acme-agent' }));
    expect(await store().getStaff('acme-agent')).toBeNull();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', action: 'removed', subject_id: 'acme-agent' });
    expect(rows[0].meta).toMatchObject({ actorScope: 'partner' });
  });

  it('partner admin: may remove a peer admin while another admin remains', async () => {
    await signInAs(ACME_ADMIN);
    await store().saveStaff(member({ username: 'acme-admin-2', role: 'admin', partnerId: 'acme' }));
    await removePartnerStaffAction(form({ username: 'acme-admin-2' }));
    expect(await store().getStaff('acme-admin-2')).toBeNull();
  });

  it('partner admin: removing yourself is a no-op', async () => {
    await signInAs(ACME_ADMIN);
    await removePartnerStaffAction(form({ username: 'acme-admin' }));
    expect(await store().getStaff('acme-admin')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('cross-tenant replay: another tenant\'s member and a platform account are the same silent no-op as a missing name', async () => {
    await store().saveStaff(ACME_AGENT);
    const token = await store().createSession('acme-agent');
    await enrol('acme-agent');
    await store().saveStaff(member({ username: 'root', role: 'admin' }));
    await signInAs(BETA_ADMIN);

    const outcomes = [
      await errorOf(removePartnerStaffAction(form({ username: 'acme-agent' }))),
      await errorOf(removePartnerStaffAction(form({ username: 'root' }))),
      await errorOf(removePartnerStaffAction(form({ username: 'no-such-user' }))),
    ];
    expect(outcomes).toEqual(['OK', 'OK', 'OK']);
    expect(await store().getStaff('acme-agent')).not.toBeNull();
    expect(await store().getSessionUser(token)).toBe('acme-agent');
    expect(await createStaffMfaStore(redis).isEnrolled('acme-agent')).toBe(true);
    expect(await store().getStaff('root')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it.each(['agent', 'support'] as const)('a partner %s is redirected and removes nothing', async (role) => {
    await store().saveStaff(ACME_AGENT);
    await signInAs(member({ username: `acme-${role}-actor`, role, partnerId: 'acme' }));
    expect(await errorOf(removePartnerStaffAction(form({ username: 'acme-agent' })))).toBe('REDIRECT:/admin-dashboard');
    expect(await store().getStaff('acme-agent')).not.toBeNull();
  });
});

describe('cross-tenant broad reads as tenant B (OWASP regression)', () => {
  it('beta sees zero acme staff and zero acme audit rows', async () => {
    await signInAs(ACME_ADMIN);
    await createPartnerStaffAction('acme', form({ username: 'acme-agent', name: 'A', password: PW, role: 'agent' }));
    await createPartnerStaffAction('acme', form({ username: 'acme-gone', name: 'A', password: PW, role: 'agent' }));
    await removePartnerStaffAction(form({ username: 'acme-gone' }));
    await signInAs(BETA_ADMIN);
    await createPartnerStaffAction('beta', form({ username: 'beta-agent', name: 'B', password: PW, role: 'agent' }));

    const all = await store().listStaff();
    const betaScope = { kind: 'partner' as const, partnerId: 'beta' };
    const leaked = [
      ...listTenantStaff(betaScope, 'beta', all).map((s) => s.username),
      ...listTenantStaff(betaScope, 'acme', all).map((s) => s.username),
    ].filter((u) => u.startsWith('acme'));
    expect(leaked).toEqual([]);

    const feed = await createAuditLogStore(db).listForPartner('beta');
    expect(feed.map((e) => e.target)).toEqual(['beta-agent']);
    expect(feed.every((e) => e.partnerId === 'beta')).toBe(true);
    expect((await createAuditLogStore(db).listForPartner('acme')).map((e) => e.action).sort()).toEqual(['created', 'created', 'removed']);
  });
});
