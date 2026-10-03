import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { StaffRole } from '@/lib/types';

// UI redesign M3-8, Task 8.2: the /partner/staff server actions (invite, revoke invite, remove).
// Real gate (requirePartnerStaff over the real auth store on a fake Redis), real partner store,
// outbox and audit repos on PGlite. Each action runs the shared per-action checklist plus its own
// cases.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
const revalidated: string[] = [];
const pokeWorkerMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => pokeWorkerMock() }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/audit-log-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-log-store')>('@/lib/audit-log-store');
  return { ...actual, getAuditLogStore: () => actual.createAuditLogStore(db) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { inviteStaffAction, removeStaffAction, revokeInviteAction } from '@/app/partner/(app)/staff/actions';
import { auditEvents, outbox } from '@/db/schema';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffInviteStore, hashInviteToken, MAX_PENDING_INVITES } from '@/lib/staff-invite-store';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { removeTenantStaff } from '@/lib/partner-staff-ops';
import { decryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';
import { STAFF_INVITE_LINK_PLACEHOLDER } from '@/lib/staff-invite-email';
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { t } from '@/lib/i18n';

const auth = () => createAuthStore(redis);
const invites = () => createStaffInviteStore(redis);
const inviteKeys = () => [...redis.dump.keys()].filter((k) => k.startsWith('staffinvite')).sort();
const auditCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n;
const outboxRows = () => db.select().from(outbox).where(eq(outbox.kind, 'email.send')).orderBy(outbox.id);
const auditRows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(auditEvents.id);
const PHONE = /\+?\d{10,}/;

function configureSmtp(): void {
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_USER', 'mailer@example.test');
  vi.stubEnv('SMTP_PASS', 'not-a-real-password');
}

async function seedMember(username: string, partnerId: string, role: StaffRole = 'agent', extra: Record<string, unknown> = {}) {
  await auth().saveStaff({
    username,
    name: `Name ${username}`,
    role,
    permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    partnerId,
    ...extra,
  });
}

beforeEach(async () => {
  redis.dump.clear();
  for (const k of [...redis.sets.keys()]) await redis.del(k); // the index sets live outside dump
  cookieJar.clear();
  revalidated.length = 0;
  pokeWorkerMock.mockReset();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedMember('pa-owner', 'pa', 'admin');
  await seedMember('pa-agent2', 'pa', 'agent');
  await seedMember('pb-member', 'pb', 'agent');
  await seedMember('pb-owner', 'pb', 'admin');
  configureSmtp();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

// ── inviteStaffAction ────────────────────────────────────────────────────────

const inviteForm = (username: string, o: Partial<Record<'email' | 'name' | 'role', string>> = {}) => {
  const fd = new FormData();
  fd.set('email', o.email ?? 'new.person@example.test');
  fd.set('username', username);
  fd.set('name', o.name ?? 'New Person');
  if (o.role !== '') fd.set('role', o.role ?? 'agent');
  return fd;
};
const inviteSnapshot = async () => ({
  keys: inviteKeys(),
  audit: await auditCount(),
  outbox: (await outboxRows()).length,
});

describe('inviteStaffAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign target, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: inviteStaffAction,
      form: (id) => inviteForm(id),
      ownId: 'pa-new',
      // Another tenant's existing username: refused like any taken name, nothing written.
      foreignId: 'pb-member',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: inviteSnapshot,
    });
    const [inv] = await invites().listForPartner('pa');
    expect(inv).toMatchObject({ partnerId: 'pa', username: 'pa-new' });
    expect(await invites().listForPartner('pb')).toEqual([]);
  });
  it('the page is open to agents (read-only roster) but every staff action stays admin-only', async () => {
    expect(PARTNER_ROUTES.staff.policy.roles).toEqual(['admin', 'agent']);
    const { own } = await seedInvites();
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    const before = { ...(await inviteSnapshot()), a: await exists('pa-agent2') };
    await expect(inviteStaffAction(inviteForm('pa-new'))).rejects.toThrow(/^REDIRECT:\/partner$/);
    await expect(revokeInviteAction(idForm(own))).rejects.toThrow(/^REDIRECT:\/partner$/);
    await expect(removeStaffAction(userForm('pa-agent2'))).rejects.toThrow(/^REDIRECT:\/partner$/);
    expect({ ...(await inviteSnapshot()), a: await exists('pa-agent2') }).toEqual(before);
  });
  it('support and finance are refused too (→ /partner), with no write', async () => {
    for (const role of ['support', 'finance', 'agent'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      const before = await inviteSnapshot();
      await expect(inviteStaffAction(inviteForm('pa-new'))).rejects.toThrow('REDIRECT:/partner');
      expect(await inviteSnapshot()).toEqual(before);
    }
  });
});

describe('inviteStaffAction: refusals (item 5: before any write)', () => {
  const refuses = async (fd: FormData) => {
    const before = await inviteSnapshot();
    const r = await inviteStaffAction(fd);
    expect(r).toMatchObject({ ok: false });
    expect(await inviteSnapshot()).toEqual(before);
    return r as { ok: false; error: string };
  };
  it('SMTP unconfigured → refused, NO Redis key, NO outbox row', async () => {
    vi.stubEnv('SMTP_HOST', '');
    await asAdmin();
    const r = await refuses(inviteForm('pa-new'));
    expect(r.error).toBe(t('partner.staff.emailUnavailable'));
    expect(inviteKeys()).toEqual([]);
  });
  it('the platform, owner and missing roles are refused', async () => {
    await asAdmin();
    for (const role of ['platform', 'owner', '', 'root', 'Admin']) {
      const r = await refuses(inviteForm('pa-new', { role }));
      expect(r.error).toBe(t('partner.staff.invalidRole'));
    }
  });
  it('every partner role may be invited, finance included', async () => {
    await asAdmin();
    for (const role of ['admin', 'agent', 'support', 'finance']) {
      expect(await inviteStaffAction(inviteForm(`pa-${role}-x`, { role }))).toEqual({ ok: true });
    }
    expect((await invites().listForPartner('pa')).map((i) => i.role).sort()).toEqual(['admin', 'agent', 'finance', 'support']);
  });
  it('bad emails (incl. multiple recipients and header injection) are refused and never echoed', async () => {
    await asAdmin();
    for (const email of ['', 'nope', 'a@b', 'a b@example.test', 'a@example.test,b@example.test', 'a@example.test;b@x.test',
      'a@example.test\r\nBcc: x@evil.test', '"q"@example.test', '<a@example.test>', `${'a'.repeat(250)}@example.test`]) {
      const r = await refuses(inviteForm('pa-new', { email }));
      expect(r.error).toBe(t('partner.staff.invalidEmail'));
    }
  });
  it('bad usernames are refused (format, reserved words)', async () => {
    await asAdmin();
    for (const u of ['', 'ab', 'Has Upper', 'a/b', 'index', 'smartremit', 'x'.repeat(65)]) {
      const r = await refuses(inviteForm(u));
      expect(r.error).toBe(t('partner.staff.invalidUsername'));
    }
  });
  it('the seed admin name is refused as unavailable', async () => {
    vi.stubEnv('SEED_ADMIN_USERNAME', 'rootowner');
    await asAdmin();
    const r = await refuses(inviteForm('rootowner'));
    expect(r.error).toBe(t('partner.staff.usernameUnavailable'));
  });
  it('an existing account (own tenant, another tenant, platform) is unavailable, with the SAME message', async () => {
    await asAdmin();
    await auth().saveStaff({ username: 'platform-x', name: 'P', role: 'admin', permissions: { canCancel: true, canResend: true, canAssign: true }, passwordHash: 'x', createdAt: new Date().toISOString() });
    const msgs = new Set<string>();
    for (const u of ['pa-agent2', 'pb-member', 'platform-x']) msgs.add((await refuses(inviteForm(u))).error);
    expect([...msgs]).toEqual([t('partner.staff.usernameUnavailable')]);
  });
  it('a second pending invite for the same username in this tenant is refused', async () => {
    await asAdmin();
    expect(await inviteStaffAction(inviteForm('pa-new'))).toEqual({ ok: true });
    const r = await refuses(inviteForm('pa-new'));
    expect(r.error).toBe(t('partner.staff.usernameUnavailable'));
  });
  it('another tenant\'s pending invite for the same name is NOT disclosed (tenant-local check)', async () => {
    await invites().issue({ partnerId: 'pb', username: 'shared-name', name: 'X', role: 'agent', invitedBy: 'pb-owner' });
    await asAdmin();
    expect(await inviteStaffAction(inviteForm('shared-name'))).toEqual({ ok: true });
  });
  it('a name of 0 or 81+ characters is refused', async () => {
    await asAdmin();
    for (const name of ['', '   ', 'n'.repeat(81)]) {
      const r = await refuses(inviteForm('pa-new', { name }));
      expect(r.error).toBe(t('partner.staff.invalidName'));
    }
  });
  it(`more than ${MAX_PENDING_INVITES} pending invites → too many`, async () => {
    for (let i = 0; i < MAX_PENDING_INVITES; i++) {
      await invites().issue({ partnerId: 'pa', username: `pend${i}`, name: 'X', role: 'agent', invitedBy: 'pa-owner' });
    }
    await asAdmin();
    const r = await refuses(inviteForm('pa-new'));
    expect(r.error).toBe(t('partner.staff.tooManyInvites'));
  });
  it('the per-tenant hourly send limit holds even when invites are revoked in between', async () => {
    await asAdmin();
    let last: unknown;
    for (let i = 0; i < 25; i++) {
      last = await inviteStaffAction(inviteForm(`burst${i}`));
      if ((last as { ok: boolean }).ok) {
        const [inv] = await invites().listForPartner('pa');
        await invites().revoke('pa', inv.id);
      }
    }
    expect(last).toEqual({ ok: false, error: t('partner.staff.tooManyInvites') });
    expect((await outboxRows()).length).toBeLessThanOrEqual(20);
  });
});

describe('inviteStaffAction: success (item 6)', () => {
  it('one sealed email.send row (no token or link in plaintext), one audit row without the email, one Redis invite', async () => {
    await asAdmin();
    expect(await inviteStaffAction(inviteForm('pa-new', { email: 'Invitee.Person@Example.test', role: 'finance' }))).toEqual({ ok: true });

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { to: string[]; subject: string; text: string; sealed: Record<string, string> };
    expect(payload.to).toEqual(['Invitee.Person@Example.test']);
    expect(Object.keys(payload.sealed)).toEqual([STAFF_INVITE_LINK_PLACEHOLDER]);
    const link = decryptField(payload.sealed.staff_invite_link, undefined, outboxSealedCtx('staff_invite_link'));
    expect(link).toMatch(/\/partner\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = link.slice(link.lastIndexOf('/') + 1);
    expect(redis.dump.has(`staffinvite:${hashInviteToken(token)}`)).toBe(true);
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('/partner/invite/');
    expect(rows[0].dedupeKey).toBe(`staff_invite:${hashInviteToken(token).slice(0, 12)}`);

    const audits = await auditRows('staff.invite.create');
    expect(audits).toHaveLength(1);
    const a = audits[0];
    expect(a).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: hashInviteToken(token).slice(0, 12) });
    expect(a.meta).toEqual({ username: 'pa-new', role: 'finance', actorScope: 'partner' });
    expect(JSON.stringify(a).toLowerCase()).not.toContain('invitee.person');
    expect(JSON.stringify(a.meta)).not.toMatch(PHONE);

    // The Redis record: no email, the session tenant, the session actor.
    const stored = redis.dump.get(`staffinvite:${hashInviteToken(token)}`)!;
    expect(stored.toLowerCase()).not.toContain('invitee.person');
    expect(JSON.parse(stored)).toMatchObject({ partnerId: 'pa', invitedBy: 'pa-admin', username: 'pa-new', role: 'finance', name: 'New Person' });

    expect(pokeWorkerMock).toHaveBeenCalledTimes(1);
    expect(revalidated).toEqual(['/partner/staff']);
  });
  it('a forged partnerId=pb puts the invite in pa', async () => {
    await asAdmin();
    const fd = inviteForm('pa-new');
    fd.set('partnerId', 'pb');
    fd.set('tenant', 'pb');
    expect(await inviteStaffAction(fd)).toEqual({ ok: true });
    expect((await invites().listForPartner('pa')).map((i) => i.partnerId)).toEqual(['pa']);
    expect(await invites().listForPartner('pb')).toEqual([]);
  });
  it('a failing transaction revokes the Redis invite and returns the generic failure', async () => {
    await asAdmin();
    // Make the audit insert fail inside the transaction: drop the table the audit repo writes to.
    await db.execute(sql`ALTER TABLE audit_events RENAME TO audit_events_gone`);
    const r = await inviteStaffAction(inviteForm('pa-new'));
    await db.execute(sql`ALTER TABLE audit_events_gone RENAME TO audit_events`);
    expect(r).toEqual({ ok: false, error: t('partner.common.failed') });
    expect(inviteKeys()).toEqual([]);
    expect(await invites().listForPartner('pa')).toEqual([]);
    expect((await outboxRows()).length).toBe(0);
    expect(pokeWorkerMock).not.toHaveBeenCalled();
  });
});

// ── revokeInviteAction ───────────────────────────────────────────────────────

async function seedInvites(): Promise<{ own: string; foreign: string }> {
  await invites().issue({ partnerId: 'pa', username: 'pa-pending', name: 'P', role: 'support', invitedBy: 'pa-owner' });
  await invites().issue({ partnerId: 'pb', username: 'pb-pending', name: 'P', role: 'agent', invitedBy: 'pb-owner' });
  const [own] = await invites().listForPartner('pa');
  const [foreign] = await invites().listForPartner('pb');
  return { own: own.id, foreign: foreign.id };
}
const idForm = (id: string) => {
  const fd = new FormData();
  fd.set('id', id);
  return fd;
};

describe('revokeInviteAction', () => {
  it('runs checklist items 1-4', async () => {
    const { own, foreign } = await seedInvites();
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: revokeInviteAction,
      form: idForm,
      ownId: own,
      foreignId: foreign,
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: async () => ({ keys: inviteKeys(), audit: await auditCount() }),
    });
    expect(await invites().listForPartner('pa')).toEqual([]);
    expect(await invites().listForPartner('pb')).toHaveLength(1);
  });
  it('unknown, malformed and foreign ids → the same not-found, nothing written', async () => {
    const { foreign } = await seedInvites();
    await asAdmin();
    const before = { keys: inviteKeys(), audit: await auditCount() };
    const results = [];
    for (const id of [foreign, '000000000000', '', 'x', "' OR 1=1"]) results.push(await revokeInviteAction(idForm(id)));
    for (const r of results) expect(r).toEqual({ ok: false, error: t('partner.staff.notFound') });
    expect({ keys: inviteKeys(), audit: await auditCount() }).toEqual(before);
  });
  it('success: one staff.invite.revoke audit row (id subject, username + role meta), and the invite is gone', async () => {
    const { own } = await seedInvites();
    await asAdmin();
    expect(await revokeInviteAction(idForm(own))).toEqual({ ok: true });
    const rows = await auditRows('staff.invite.revoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: own });
    expect(rows[0].meta).toEqual({ username: 'pa-pending', role: 'support', actorScope: 'partner' });
    expect(await revokeInviteAction(idForm(own))).toEqual({ ok: false, error: t('partner.staff.notFound') });
    expect(await auditRows('staff.invite.revoke')).toHaveLength(1);
    expect(revalidated).toContain('/partner/staff');
  });
});

// ── removeStaffAction ────────────────────────────────────────────────────────

const userForm = (username: string) => {
  const fd = new FormData();
  fd.set('username', username);
  return fd;
};
const exists = async (u: string) => (await auth().getStaff(u)) !== null;
const removeSnapshot = async () => ({
  a: await exists('pa-agent2'),
  b: await exists('pb-member'),
  audit: await auditCount(),
});

describe('removeStaffAction', () => {
  it('runs checklist items 1-4', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: removeStaffAction,
      form: userForm,
      ownId: 'pa-agent2',
      foreignId: 'pb-member',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: removeSnapshot,
    });
    expect(await exists('pa-agent2')).toBe(false);
    expect(await exists('pb-member')).toBe(true);
  });
  it('a pb username → not found, no change; a missing one → the SAME result', async () => {
    await asAdmin();
    const before = await removeSnapshot();
    const foreign = await removeStaffAction(userForm('pb-member'));
    const missing = await removeStaffAction(userForm('nobody-here'));
    const blank = await removeStaffAction(userForm(''));
    expect(foreign).toEqual({ ok: false, error: t('partner.staff.notFound') });
    expect(missing).toEqual(foreign);
    expect(blank).toEqual(foreign);
    expect(await removeSnapshot()).toEqual(before);
  });
  it('removing yourself → not found (noop), nothing written', async () => {
    await asAdmin();
    const before = await auditCount();
    expect(await removeStaffAction(userForm('pa-admin'))).toEqual({ ok: false, error: t('partner.staff.notFound') });
    expect(await exists('pa-admin')).toBe(true);
    expect(await auditCount()).toBe(before);
  });
  it('a platform account → not found, untouched', async () => {
    await auth().saveStaff({ username: 'platform-x', name: 'P', role: 'admin', permissions: { canCancel: true, canResend: true, canAssign: true }, passwordHash: 'x', createdAt: new Date().toISOString() });
    await asAdmin();
    expect(await removeStaffAction(userForm('platform-x'))).toEqual({ ok: false, error: t('partner.staff.notFound') });
    expect(await exists('platform-x')).toBe(true);
  });
  it('a member SmartRemit suspended → refused with the suspended message', async () => {
    await seedMember('pa-susp', 'pa', 'agent', { status: 'suspended' });
    await asAdmin();
    expect(await removeStaffAction(userForm('pa-susp'))).toEqual({ ok: false, error: t('partner.staff.suspended') });
    expect(await exists('pa-susp')).toBe(true);
  });
  it('another active admin may be removed (two active admins → one)', async () => {
    await asAdmin();
    await seedMember('pa-admin2', 'pa', 'admin');
    expect(await removeStaffAction(userForm('pa-admin2'))).toEqual({ ok: true });
    expect(await exists('pa-admin2')).toBe(false);
  });
  it('the last active admin → refused (core; the /partner actor is always a second active admin, so this is defence in depth)', async () => {
    const platform = { username: 'platform-root', name: 'R', role: 'admin' as const, permissions: { canCancel: true, canResend: true, canAssign: true }, passwordHash: 'x', createdAt: new Date().toISOString() };
    await seedMember('pa-susp-admin', 'pa', 'admin', { status: 'suspended' });
    // pa-owner is pa's only ACTIVE admin.
    expect(await removeTenantStaff(platform, 'pa', 'pa-owner')).toBe('last_admin');
    expect(await exists('pa-owner')).toBe(true);
    // The tenant argument binds the target: a pb member is a noop for tenant pa.
    expect(await removeTenantStaff(platform, 'pa', 'pb-member')).toBe('noop');
    expect(await removeTenantStaff(platform, '', 'pa-agent2')).toBe('noop');
    expect(await exists('pa-agent2')).toBe(true);
  });
  it('the core maps suspended to "suspended" for a partner actor, and the MFA marker survives a refusal', async () => {
    await seedMember('pa-susp', 'pa', 'agent', { status: 'suspended' });
    await redis.set(`${MFA_PENDING_PREFIX}pa-susp`, '1');
    const actor = (await auth().getStaff('pa-owner'))!;
    expect(await removeTenantStaff(actor, 'pa', 'pa-susp')).toBe('suspended');
    expect(redis.dump.has(`${MFA_PENDING_PREFIX}pa-susp`)).toBe(true);
  });
  it('success: sessions, MFA keys and the invite MFA marker are cleared; one audit row, actorScope partner', async () => {
    await asAdmin();
    const sid = await auth().createSession('pa-agent2');
    expect(await auth().getSessionUser(sid)).toBe('pa-agent2');
    await redis.set(`${MFA_PENDING_PREFIX}pa-agent2`, '1');
    await redis.set('staff_mfa:pa-agent2', JSON.stringify({ secretEnc: 'x', enrolledAt: new Date().toISOString() }));
    expect(await removeStaffAction(userForm('pa-agent2'))).toEqual({ ok: true });
    expect(await exists('pa-agent2')).toBe(false);
    expect(await auth().getSessionUser(sid)).toBeNull();
    expect(redis.dump.has(`${MFA_PENDING_PREFIX}pa-agent2`)).toBe(false);
    expect(redis.dump.has('staff_mfa:pa-agent2')).toBe(false);
    const rows = await auditRows('removed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', subjectId: 'pa-agent2' });
    expect((rows[0].meta as { actorScope: string }).actorScope).toBe('partner');
    expect(JSON.stringify(rows[0].meta)).not.toMatch(PHONE);
    expect(revalidated).toContain('/partner/staff');
  });
});
