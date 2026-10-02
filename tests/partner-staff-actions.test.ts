/**
 * Partner staff create/remove (createPartnerStaffAction / removePartnerStaffAction).
 *
 * partner-demo R5: a partner ADMIN managed their OWN tenant's staff here; since
 * UI M5 these legacy actions are platform-only (partner staff are sent to
 * /partner, see /partner/staff) and a platform admin manages any tenant's.
 * The REAL @/lib/auth runs here (session cookie →
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
  // The legacy actions refuse on a partner-site host (site-host-guard): run them as on the apex.
  headers: async () => new Headers({ host: 'smartremit.ai' }),
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
    await createPartnerStaffAction('acme', form({ username: 'pp1', name: 'Partner One', password: PW, role: 'admin' }));
    const got = await store().getStaff('pp1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
    expect(got?.passwordHash).toMatch(/^\$pv=p0\$\$argon2id\$/); // Program-Fix 45 P4
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'ops', actor_type: 'staff', action: 'created', subject_id: 'pp1' });
    expect(rows[0].meta).toMatchObject({ actorScope: 'platform' });
    expect(JSON.stringify(rows[0].meta)).not.toContain(PW);
    expect(JSON.stringify(rows[0].meta)).not.toContain('argon2');
  });

  it('ignores a partnerId in the form (the bound selector decides)', async () => {
    await createPartnerStaffAction('acme', form({ username: 'pp2', name: 'P Two', password: PW, role: 'agent', partnerId: 'beta' }));
    expect((await store().getStaff('pp2'))?.partnerId).toBe('acme');
  });

  it('Program-Fix 17a: refuses a short or breached password, and an HIBP outage (fail-closed), without writing', async () => {
    await expect(createPartnerStaffAction('acme', form({ username: 'pp3', name: 'P3', password: 'hunter2', role: 'agent' }))).rejects.toThrow(/12 characters/);
    pwnedStatus.mockImplementationOnce(async () => 'pwned');
    await expect(createPartnerStaffAction('acme', form({ username: 'pp3', name: 'P3', password: PW, role: 'agent' }))).rejects.toThrow(/breach/);
    pwnedStatus.mockImplementationOnce(async () => 'unavailable');
    await expect(createPartnerStaffAction('acme', form({ username: 'pp3', name: 'P3', password: PW, role: 'agent' }))).rejects.toThrow(/unavailable/i);
    expect(await store().getStaff('pp3')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('throws on an invalid role and on missing fields', async () => {
    await expect(createPartnerStaffAction('acme', form({ username: 'xxx', name: 'x', password: PW, role: 'root' }))).rejects.toThrow(/role/i);
    await expect(createPartnerStaffAction('acme', form({ username: '', name: 'x', password: PW, role: 'agent' }))).rejects.toThrow();
  });

  it('throws when the partner does not exist', async () => {
    await expect(createPartnerStaffAction('ghost', form({ username: 'pp1', name: 'P', password: PW, role: 'agent' }))).rejects.toThrow(NOT_FOUND);
  });

  it('refuses to clobber an existing record with a generic message (no silent rebind)', async () => {
    await store().saveStaff(member({ username: 'root', role: 'admin', passwordHash: 'pre:existing' }));
    const msg = await errorOf(createPartnerStaffAction('acme', form({ username: 'root', name: 'New', password: PW, role: 'agent' })));
    expect(msg).toMatch(/choose another username/i);
    const orig = await store().getStaff('root');
    expect(orig?.partnerId).toBeUndefined();
    expect(orig?.passwordHash).toBe('pre:existing');
  });

  it('fix round 1: the username format is enforced on create (reserved `index`, bad characters, too short)', async () => {
    for (const bad of ['index', 'Bad Name', 'ab', 'a:b']) {
      expect(await errorOf(createPartnerStaffAction('acme', form({ username: bad, name: 'N', password: PW, role: 'agent' })))).toMatch(/3.64 characters/);
    }
    expect(await store().getStaff('index')).toBeNull();
    expect(await auditRows()).toEqual([]);
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
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'pp9', name: 'P', password: PW, role: 'agent' })))).toBe(ENROL);
    expect(await errorOf(removePartnerStaffAction(form({ username: 'acme-agent' })))).toBe(ENROL);
    expect(await store().getStaff('pp9')).toBeNull();
    expect(await store().getStaff('acme-agent')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });
});

// UI M5 (one partner dashboard): /admin-dashboard is SmartRemit-only. requireStaff sends ANY
// partner-scoped staff to /partner before requireStaffManager decides the actor kind, so a partner
// admin can no longer create or remove staff here, in its own tenant or another. Partner admins
// manage their team on /partner/staff (tests/partner-staff-app-actions.test.ts pins its contract:
// forged tenant fields, foreign targets, self-removal, SmartRemit-suspended members, the last
// admin). The behaviour below that does not depend on the actor kind now runs as a platform admin.
const TO_PARTNER = 'REDIRECT:/partner';

describe('createPartnerStaffAction — partner admin (UI M5: sent to /partner)', () => {
  beforeEach(() => signInAs(ACME_ADMIN));

  it('own tenant, another tenant, a missing one and an empty selector all redirect; nothing written', async () => {
    for (const sel of ['acme', 'beta', 'nope', '']) {
      expect(await errorOf(createPartnerStaffAction(sel, form({ username: 'xx1', name: 'X', password: PW, role: 'agent' })))).toBe(TO_PARTNER);
    }
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'acme-admin-2', name: 'A2', password: PW, role: 'admin', partnerId: '' })))).toBe(TO_PARTNER);
    expect(await store().getStaff('xx1')).toBeNull();
    expect(await store().getStaff('acme-admin-2')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('cannot touch its own record: its own username redirects and the record is unchanged', async () => {
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'acme-admin', name: 'Me', password: PW, role: 'admin' })))).toBe(TO_PARTNER);
    const me = await store().getStaff('acme-admin');
    expect(me?.partnerId).toBe('acme');
    expect(me?.passwordHash).toBe('salt:hash');
    expect(await auditRows()).toEqual([]);
  });

  it('with STAFF_MFA_REQUIRED on, an unenrolled or enrolled partner admin is sent to /partner (not to the legacy enrolment)', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'gg1', name: 'G', password: PW, role: 'agent' })))).toBe(TO_PARTNER);
    await enrol('acme-admin');
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'gg1', name: 'G', password: PW, role: 'agent' })))).toBe(TO_PARTNER);
    expect(await store().getStaff('gg1')).toBeNull();
  });

  it('no create budget is spent by a refused partner admin', async () => {
    for (let i = 0; i < 25; i++) {
      expect(await errorOf(createPartnerStaffAction('acme', form({ username: `bulk${i}`, name: 'B', password: PW, role: 'agent' })))).toBe(TO_PARTNER);
    }
    expect([...redis.dump.keys()].filter((k) => k.includes('partner_staff_create'))).toEqual([]);
  });
});

describe('createPartnerStaffAction — platform admin creating in a tenant (actor-independent rules)', () => {
  beforeEach(() => signInAs(PLATFORM));

  it('role=admin plus a forged partnerId never yields a platform account (a tenant-pinned admin at most)', async () => {
    await createPartnerStaffAction('acme', form({ username: 'acme-admin-2', name: 'A2', password: PW, role: 'admin', partnerId: '' }));
    const got = await store().getStaff('acme-admin-2');
    expect(got?.role).toBe('admin');
    expect(got?.partnerId).toBe('acme');
  });

  it('cannot escalate its own record: its own username collides generically and its record is unchanged', async () => {
    const msg = await errorOf(createPartnerStaffAction('acme', form({ username: 'ops', name: 'Me', password: PW, role: 'admin' })));
    expect(msg).toMatch(/choose another username/i);
    const me = await store().getStaff('ops');
    expect(me?.partnerId).toBeUndefined();
    expect(me?.passwordHash).toBe('salt:hash');
    expect(await auditRows()).toEqual([]);
  });

  it('an empty selector is refused like a missing partner and writes nothing', async () => {
    const missing = await errorOf(createPartnerStaffAction('nope', form({ username: 'xx1', name: 'X', password: PW, role: 'agent' })));
    expect(missing).toMatch(NOT_FOUND);
    expect(await errorOf(createPartnerStaffAction('', form({ username: 'xx1', name: 'X', password: PW, role: 'admin' })))).toBe(missing);
    expect(await store().getStaff('xx1')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('a new member starts with no MFA enrolment left over from a re-used name', async () => {
    await enrol('reuse');
    await createPartnerStaffAction('acme', form({ username: 'reuse', name: 'R', password: PW, role: 'agent' }));
    expect(await createStaffMfaStore(redis).isEnrolled('reuse')).toBe(false);
  });

  it('a create that loses the SET NX race never resets the WINNER\'s MFA enrolment', async () => {
    // The winner landed between our existence check and our claim: simulate
    // by hiding its record from the pre-check read only.
    await store().saveStaff(member({ username: 'racer', partnerId: 'acme' }));
    await enrol('racer');
    const realGet = redis.get.bind(redis);
    let hidden = false;
    redis.get = (async (k: string) => {
      if (k === 'staff:racer' && !hidden) {
        hidden = true;
        return null;
      }
      return realGet(k);
    }) as typeof redis.get;
    try {
      expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'racer', name: 'R2', password: PW, role: 'agent' })))).not.toBe('OK');
    } finally {
      redis.get = realGet;
    }
    expect(hidden).toBe(true);
    expect(await createStaffMfaStore(redis).isEnrolled('racer')).toBe(true);
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
  it.each(['agent', 'support'] as const)('a partner %s is redirected to /partner and writes nothing', async (role) => {
    await signInAs(member({ username: `acme-${role}`, role, partnerId: 'acme' }));
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'zzz', name: 'Z', password: PW, role: 'agent' })))).toBe(TO_PARTNER);
    expect(await store().getStaff('zzz')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it.each(['agent', 'support'] as const)('a platform %s is redirected to the dashboard and writes nothing', async (role) => {
    await signInAs(member({ username: `plat-${role}`, role }));
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'zzz', name: 'Z', password: PW, role: 'agent' })))).toBe('REDIRECT:/admin-dashboard');
    expect(await store().getStaff('zzz')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('no session → sent to login', async () => {
    expect(await errorOf(createPartnerStaffAction('acme', form({ username: 'zzz', name: 'Z', password: PW, role: 'agent' })))).toBe('REDIRECT:/login');
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
    expect(rows[0].meta).toMatchObject({ actorScope: 'platform' });
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
    const msg = await errorOf(removePartnerStaffAction(form({ username: 'acme-only' })));
    expect(msg).toMatch(/only admin/i);
    expect(msg).toMatch(/Team page/); // fix round 1: offboarding goes through the Team page
    expect(await store().getStaff('acme-only')).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('platform admin: may remove a peer admin while another admin remains', async () => {
    await store().saveStaff(ACME_ADMIN);
    await store().saveStaff(member({ username: 'acme-admin-2', role: 'admin', partnerId: 'acme' }));
    await signInAs(PLATFORM);
    await removePartnerStaffAction(form({ username: 'acme-admin-2' }));
    expect(await store().getStaff('acme-admin-2')).toBeNull();
    expect(await store().getStaff('acme-admin')).not.toBeNull();
  });

  it('platform admin: a missing name is a silent no-op', async () => {
    await signInAs(PLATFORM);
    expect(await errorOf(removePartnerStaffAction(form({ username: 'no-such-user' })))).toBe('OK');
    expect(await auditRows()).toEqual([]);
  });

  it('fix round 1: a platform admin can still remove a suspended partner member', async () => {
    await signInAs(PLATFORM);
    await store().saveStaff(member({ username: 'acme-sus', partnerId: 'acme', status: 'suspended' }));
    await removePartnerStaffAction(form({ username: 'acme-sus' }));
    expect(await store().getStaff('acme-sus')).toBeNull();
  });

  // UI M5: every partner actor is sent to /partner before any target is read, so own-tenant,
  // cross-tenant, platform, suspended and self targets are all left untouched (the /partner
  // removeStaffAction pins those cases: tests/partner-staff-app-actions.test.ts).
  it.each(['admin', 'agent', 'support'] as const)('a partner %s is redirected to /partner and removes nothing, whatever the target', async (role) => {
    await store().saveStaff(ACME_AGENT);
    const token = await store().createSession('acme-agent');
    await enrol('acme-agent');
    await store().saveStaff(member({ username: 'acme-sus', partnerId: 'acme', status: 'suspended' }));
    await store().saveStaff(member({ username: 'beta-agent', partnerId: 'beta' }));
    await store().saveStaff(member({ username: 'root', role: 'admin' }));
    const actor = member({ username: `acme-${role}-actor`, role, partnerId: 'acme' });
    await signInAs(actor);
    for (const username of ['acme-agent', 'acme-sus', 'beta-agent', 'root', actor.username, 'no-such-user']) {
      expect(await errorOf(removePartnerStaffAction(form({ username })))).toBe(TO_PARTNER);
    }
    for (const username of ['acme-agent', 'acme-sus', 'beta-agent', 'root', actor.username]) {
      expect(await store().getStaff(username)).not.toBeNull();
    }
    expect(await store().getSessionUser(token)).toBe('acme-agent');
    expect(await createStaffMfaStore(redis).isEnrolled('acme-agent')).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('with STAFF_MFA_REQUIRED on, a partner admin is sent to /partner (not to the legacy enrolment)', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await store().saveStaff(ACME_AGENT);
    await signInAs(ACME_ADMIN);
    expect(await errorOf(removePartnerStaffAction(form({ username: 'acme-agent' })))).toBe(TO_PARTNER);
    expect(await store().getStaff('acme-agent')).not.toBeNull();
  });
});

describe('cross-tenant broad reads as tenant B (OWASP regression)', () => {
  it('beta sees zero acme staff and zero acme audit rows', async () => {
    // UI M5: the legacy writes are platform-only now; the tenant-scoped reads are unchanged.
    await signInAs(PLATFORM);
    await createPartnerStaffAction('acme', form({ username: 'acme-agent', name: 'A', password: PW, role: 'agent' }));
    await createPartnerStaffAction('acme', form({ username: 'acme-gone', name: 'A', password: PW, role: 'agent' }));
    await removePartnerStaffAction(form({ username: 'acme-gone' }));
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
