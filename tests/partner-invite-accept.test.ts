import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff, StaffRole } from '@/lib/types';

// UI redesign M3-9, Task 9.2: the public invite page (GET, peek only) and acceptInviteAction (POST,
// consume). Real invite store, auth store and MFA store on a fake Redis; real partner store and
// audit repos on PGlite; the HIBP check stubbed to "clean"; the page limiter on its own fake Redis.
const redis = fakeRedis();
const limiter = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
let currentIp = '198.51.100.20';
let pwnedStatus: 'clean' | 'pwned' | 'unavailable' = 'clean';
let currentHost = 'smartremit.ai';
type AuthStoreT = ReturnType<typeof import('@/lib/auth-store').createAuthStore>;
let authOverride: ((base: AuthStoreT) => AuthStoreT) | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ 'x-forwarded-for': currentIp, host: currentHost }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/pwned', async (orig) => ({
  ...(await orig<typeof import('@/lib/pwned')>()),
  pwnedPasswordStatus: async () => pwnedStatus,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return {
    ...actual,
    getAuthStore: () => {
      const base = actual.createAuthStore(redis);
      return authOverride ? authOverride(base) : base;
    },
  };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/ip-rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ip-rate-limit')>('@/lib/ip-rate-limit');
  return {
    ...actual,
    isIpRateLimited: (h: Headers, scope: string, limit: number, windowSec?: number) =>
      actual.isIpRateLimited(h, scope, limit, windowSec, { redis: limiter }),
  };
});

import InvitePage from '@/app/partner/invite/[token]/page';
import { acceptInviteAction } from '@/app/partner/invite/[token]/actions';
import { DEAD_INVITE, INVITE_ACCEPT_IP_LIMIT, INVITE_PAGE_IP_LIMIT } from '@/app/partner/invite/[token]/accept-result';
import { auditEvents } from '@/db/schema';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { createStaffInviteStore } from '@/lib/staff-invite-store';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { verifyPassword } from '@/lib/password';
import { t } from '@/lib/i18n';

const STRONG = 'Str0ng-passphrase-for-tests!';
const auth = () => createAuthStore(redis);
const invites = (now?: () => Date) => createStaffInviteStore(redis, now);
const auditRows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(auditEvents.id);
const auditCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n;

async function seedMember(username: string, partnerId: string | undefined, role: StaffRole = 'admin', extra: Partial<Staff> = {}) {
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

async function issueFor(partnerId: string, username: string, o: { role?: StaffRole; invitedBy?: string; now?: () => Date } = {}) {
  const r = await invites(o.now).issue({
    partnerId,
    username,
    name: 'New Person',
    role: o.role ?? 'agent',
    invitedBy: o.invitedBy ?? `${partnerId}-owner`,
  });
  if ('error' in r) throw new Error('issue refused');
  return r.token;
}

function form(token: string, password: string, confirm = password, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('token', token);
  fd.set('password', password);
  fd.set('confirm', confirm);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

async function accept(token: string, password: string, confirm = password, extra: Record<string, string> = {}) {
  return acceptInviteAction(form(token, password, confirm, extra));
}

async function page(token: string): Promise<string> {
  return renderToStaticMarkup(await InvitePage({ params: Promise.resolve({ token }) }));
}

beforeEach(async () => {
  redis.dump.clear();
  for (const k of [...redis.sets.keys()]) await redis.del(k);
  limiter.dump.clear();
  currentIp = '198.51.100.20';
  currentHost = 'smartremit.ai';
  authOverride = null;
  pwnedStatus = 'clean';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedMember('pa-owner', 'pa');
  await seedMember('pb-owner', 'pb');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('/partner/invite/[token] page (GET: peek only)', () => {
  it('a live invite renders the form: partner name, role, username, the token hidden; nothing consumed', async () => {
    const token = await issueFor('pa', 'pa-new');
    const html = await page(token);
    expect(html).toContain('data-testid="partner-invite-form"');
    expect(html).toContain('Partner A');
    expect(html).toContain('pa-new');
    expect(html).toContain(t('partner.staff.role.agent'));
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).not.toContain(t('partner.invite.deadTitle'));
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    // The header is inside the client form, so a dead action result replaces it (never two headings).
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/app/partner/invite/[token]/page.tsx', 'utf8')).not.toMatch(/<h1/);
    expect(readFileSync('src/app/partner/invite/[token]/accept-form.tsx', 'utf8')).toMatch(/if \(state && 'dead' in state\) return <DeadInvite \/>;[\s\S]*<h1/);
    // A mail scanner's prefetch must never burn the link.
    expect(await invites().peek(token)).not.toBeNull();
    expect(await page(token)).toContain('data-testid="partner-invite-form"');
  });

  it('the dead sheet is byte-identical for every failure mode (no oracle)', async () => {
    const unknown = 'A'.repeat(43);
    const malformed = 'not-a-token';
    const expired = await issueFor('pa', 'pa-exp', { now: () => new Date(Date.now() - 73 * 3600 * 1000) });
    const used = await issueFor('pa', 'pa-used');
    expect(await invites().consume(used)).not.toBeNull();
    const revoked = await issueFor('pa', 'pa-rev');
    const id = (await invites().listForPartner('pa')).find((i) => i.username === 'pa-rev')!.id;
    expect(await invites().revoke('pa', id)).toBe(true);
    const suspended = await issueFor('pb', 'pb-new');
    await pgPartnerStore.savePartner({ ...(await pgPartnerStore.getPartner('pb'))!, status: 'suspended' });
    const inviterGone = await issueFor('pa', 'pa-orphan', { invitedBy: 'pa-exadmin' });
    const taken = await issueFor('pa', 'pa-taken');
    await seedMember('pa-taken', 'pa', 'agent');

    const sheets = [];
    for (const tok of [unknown, malformed, expired, used, revoked, suspended, inviterGone, taken]) sheets.push(await page(tok));
    // Rate-limited: this IP is already at the page limit for the current window.
    currentIp = '203.0.113.9';
    const window = Math.floor(Date.now() / 60_000);
    limiter.dump.set(`iprl|partner-invite|${currentIp}|${window}`, String(INVITE_PAGE_IP_LIMIT));
    sheets.push(await page(await issueFor('pa', 'pa-limited')));

    expect(sheets[0]).toContain(t('partner.invite.deadTitle'));
    expect(new Set(sheets).size).toBe(1);
    for (const s of sheets) {
      expect(s).not.toContain('Partner A');
      expect(s).not.toContain('Partner B');
      expect(s).not.toContain('name="token"');
    }
  });
});

describe('acceptInviteAction (POST: consume)', () => {
  it('success: creates the account in the INVITE’s tenant and role, sets the MFA marker, audits, redirects to /login', async () => {
    const token = await issueFor('pa', 'pa-new', { role: 'finance' });
    await expect(accept(token, STRONG)).rejects.toThrow('REDIRECT:/login');
    const s = await auth().getStaff('pa-new');
    expect(s).toMatchObject({ username: 'pa-new', partnerId: 'pa', role: 'finance', name: 'New Person' });
    expect(s?.status).toBeUndefined();
    expect(await verifyPassword(STRONG, s!.passwordHash)).toBe(true);
    // Forced MFA: the marker is present and carries NO TTL (the fake keeps it; the key is plain).
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-new`)).toBe('1');
    // Single use.
    expect(await invites().peek(token)).toBeNull();
    const rows = await auditRows('staff.invite.accept');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-new', actorType: 'staff', subjectId: 'pa-new' });
    expect(rows[0].meta).toEqual({ role: 'finance', invitedBy: 'pa-owner', actorScope: 'partner' });
    const created = await auditRows('created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ partnerId: 'pa', subjectId: 'pa-new' });
    expect((created[0].meta as { actorScope?: string }).actorScope).toBe('partner');
    // Never a password or hash anywhere in the audit rows.
    const all = JSON.stringify(await db.select().from(auditEvents));
    expect(all).not.toContain(STRONG);
    expect(all).not.toContain(s!.passwordHash);
    expect(all).not.toMatch(/\+?\d{10,}/);
  });

  it('the marker is set with NX and no expiry (a late first sign-in is still forced to enrol)', async () => {
    const setSpy = vi.spyOn(redis, 'set');
    const token = await issueFor('pa', 'pa-new');
    setSpy.mockClear();
    await expect(accept(token, STRONG)).rejects.toThrow('REDIRECT:/login');
    const markerCalls = setSpy.mock.calls.filter(([k]) => k === `${MFA_PENDING_PREFIX}pa-new`);
    expect(markerCalls).toHaveLength(1);
    expect(markerCalls[0][2]).toEqual({ nx: true });
    // The marker was written BEFORE the account claim (staff:<name> SET NX).
    const order = setSpy.mock.calls.map(([k]) => k);
    expect(order.indexOf(`${MFA_PENDING_PREFIX}pa-new`)).toBeLessThan(order.indexOf('staff:pa-new'));
    setSpy.mockRestore();
  });

  it('tenant, role, username and name come ONLY from the consumed invite (forged form fields are ignored)', async () => {
    const token = await issueFor('pa', 'pa-new', { role: 'agent' });
    await expect(
      accept(token, STRONG, STRONG, { partnerId: 'pb', partner: 'pb', role: 'admin', username: 'evil', name: 'Evil' }),
    ).rejects.toThrow('REDIRECT:/login');
    expect(await auth().getStaff('pa-new')).toMatchObject({ partnerId: 'pa', role: 'agent', name: 'New Person' });
    expect(await auth().getStaff('evil')).toBeNull();
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain('"pb"');
  });

  it('two parallel accepts create exactly one account (atomic consume)', async () => {
    const token = await issueFor('pa', 'pa-new');
    const [a, b] = await Promise.allSettled([accept(token, STRONG), accept(token, STRONG)]);
    expect(await auth().getStaff('pa-new')).toMatchObject({ partnerId: 'pa', role: 'agent' });
    const redirected = [a, b].filter((r) => r.status === 'rejected' && String(r.reason).includes('REDIRECT:/login'));
    expect(redirected).toHaveLength(1);
    const other = [a, b].find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<unknown>;
    expect(other.value).toEqual(DEAD_INVITE);
    expect(await auditRows('staff.invite.accept')).toHaveLength(1);
  });

  it('a weak, breached or mismatched password does not burn the token and writes nothing', async () => {
    const token = await issueFor('pa', 'pa-new');
    const before = await auditCount();
    expect(await accept(token, 'short')).toMatchObject({ ok: false, error: expect.stringContaining('at least 12') });
    expect(await accept(token, STRONG, STRONG + 'x')).toEqual({ ok: false, error: t('partner.invite.mismatch') });
    pwnedStatus = 'pwned';
    expect(await accept(token, STRONG)).toMatchObject({ ok: false, error: expect.stringContaining('breach') });
    pwnedStatus = 'unavailable'; // create-class: the breach check fails CLOSED
    expect(await accept(token, STRONG)).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') });
    expect(await invites().peek(token)).not.toBeNull();
    expect(await auth().getStaff('pa-new')).toBeNull();
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-new`)).toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it('every dead case returns the SAME result object and creates nothing', async () => {
    const cases: string[] = [];
    cases.push('A'.repeat(43)); // unknown
    cases.push('not-a-token'); // malformed
    cases.push(await issueFor('pa', 'pa-exp', { now: () => new Date(Date.now() - 73 * 3600 * 1000) })); // expired
    const used = await issueFor('pa', 'pa-used');
    await invites().consume(used);
    cases.push(used);
    const revoked = await issueFor('pa', 'pa-rev');
    await invites().revoke('pa', (await invites().listForPartner('pa')).find((i) => i.username === 'pa-rev')!.id);
    cases.push(revoked);
    cases.push(await issueFor('pa', 'pa-orphan', { invitedBy: 'pa-exadmin' })); // inviter no longer exists
    const suspended = await issueFor('pb', 'pb-new');
    await pgPartnerStore.savePartner({ ...(await pgPartnerStore.getPartner('pb'))!, status: 'suspended' });
    cases.push(suspended);
    for (const tok of cases) expect(await accept(tok, STRONG)).toEqual(DEAD_INVITE);
    for (const u of ['pa-exp', 'pa-used', 'pa-rev', 'pa-orphan', 'pb-new']) {
      expect(await auth().getStaff(u)).toBeNull();
      expect(await redis.get(`${MFA_PENDING_PREFIX}${u}`)).toBeNull();
    }
    expect(await auditRows('staff.invite.accept')).toHaveLength(0);
  });

  it('the inviting admin was removed, suspended or demoted after issuing → dead (#421 review)', async () => {
    const t1 = await issueFor('pa', 'pa-n1');
    await auth().saveStaff({ ...(await auth().getStaff('pa-owner'))!, status: 'suspended' });
    expect(await accept(t1, STRONG)).toEqual(DEAD_INVITE);
    await auth().saveStaff({ ...(await auth().getStaff('pa-owner'))!, status: undefined, role: 'agent' });
    const t2 = await issueFor('pa', 'pa-n2');
    expect(await accept(t2, STRONG)).toEqual(DEAD_INVITE);
    expect(await auth().getStaff('pa-n1')).toBeNull();
    expect(await auth().getStaff('pa-n2')).toBeNull();
  });

  it('cross-tenant same username: A accepts, then B’s invite for that name is dead; the account and A’s marker stay', async () => {
    const ta = await issueFor('pa', 'shared-name');
    const tb = await issueFor('pb', 'shared-name');
    await expect(accept(ta, STRONG)).rejects.toThrow('REDIRECT:/login');
    expect(await accept(tb, STRONG)).toEqual(DEAD_INVITE);
    expect(await auth().getStaff('shared-name')).toMatchObject({ partnerId: 'pa' });
    expect(await redis.get(`${MFA_PENDING_PREFIX}shared-name`)).toBe('1');
  });

  it('the username was taken between the checks and the claim (lost createStaff race) → dead, the winner untouched', async () => {
    const token = await issueFor('pa', 'pa-race');
    // The winner appears between inviteRedeemable's free-name pre-check and our SET NX claim.
    let calls = 0;
    const winner: Staff = {
      username: 'pa-race', name: 'Winner', role: 'admin', partnerId: 'pb',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
      passwordHash: 'winner-hash', createdAt: new Date().toISOString(),
    };
    authOverride = (base) => ({
      ...base,
      getStaff: async (u: string) => {
        const r = await base.getStaff(u);
        if (u === 'pa-race' && ++calls === 1) await base.saveStaff(winner);
        return r;
      },
    });
    expect(await accept(token, STRONG)).toEqual(DEAD_INVITE);
    authOverride = null;
    expect(await auth().getStaff('pa-race')).toMatchObject({ partnerId: 'pb', passwordHash: 'winner-hash' });
    expect(await auditRows('staff.invite.accept')).toHaveLength(0);
  });

  it('a ledger failure in createStaff → failed(), no account, and the marker is NOT deleted (never strip another account’s marker)', async () => {
    const token = await issueFor('pa', 'pa-fail');
    authOverride = (base) => ({
      ...base,
      createStaff: async () => {
        throw new Error('staff ledger write failed');
      },
    });
    expect(await accept(token, STRONG)).toEqual({ ok: false, error: t('partner.common.failed') });
    authOverride = null;
    expect(await auth().getStaff('pa-fail')).toBeNull();
    // A leftover marker only ever forces enrolment (fail-safe); enrolment or removal clears it.
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-fail`)).toBe('1');
    expect(await auditRows('staff.invite.accept')).toHaveLength(0);
  });

  it('a stale enrolment on a re-used name is reset (the new owner enrols afresh)', async () => {
    const mfa = createStaffMfaStore(redis);
    const begun = await mfa.beginEnrolment('pa-new');
    if (!begun.ok) throw new Error('enrol refused');
    const { base32Decode, totpAt } = await import('@/lib/totp');
    expect(await mfa.confirmEnrolment('pa-new', totpAt(base32Decode(begun.secretBase32), Date.now()))).toBe('ok');
    const token = await issueFor('pa', 'pa-new');
    await expect(accept(token, STRONG)).rejects.toThrow('REDIRECT:/login');
    expect(await mfa.isEnrolled('pa-new')).toBe(false);
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-new`)).toBe('1');
  });

  it('the per-IP limiter trips after the configured burst and returns the dead result without consuming', async () => {
    const token = await issueFor('pa', 'pa-new');
    for (let i = 0; i < INVITE_ACCEPT_IP_LIMIT; i++) await accept('A'.repeat(43), STRONG);
    expect(await accept(token, STRONG)).toEqual(DEAD_INVITE);
    expect(await invites().peek(token)).not.toBeNull();
    // Another address is unaffected.
    currentIp = '198.51.100.99';
    await expect(accept(token, STRONG)).rejects.toThrow('REDIRECT:/login');
  });

  it('refuses to run on a partner subdomain (site-host guard first)', async () => {
    currentHost = 'acme.smartremit.ai';
    await expect(accept('A'.repeat(43), STRONG)).rejects.toThrow('NOT_FOUND');
  });
});
