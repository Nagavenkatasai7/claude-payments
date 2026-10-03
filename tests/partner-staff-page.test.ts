import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-8, Task 8.3: /partner/staff. The page gates itself (admin only), lists the SESSION
// tenant's members only (never another tenant's, never platform accounts), shows MFA state and
// pending invites (never an email, never a token), and carries no tenant field anywhere.
const redis = fakeRedis();
const box: { db: Db | null } = { db: null };
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => box.db };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { getAuthStore } from '@/lib/auth-store';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { createStaffInviteStore } from '@/lib/staff-invite-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import StaffPage from '@/app/partner/(app)/staff/page';
import { t } from '@/lib/i18n';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const mkStaff = (o: Partial<Staff>): Staff => ({
  username: 'u1',
  name: 'U',
  role: 'agent',
  permissions: perms,
  passwordHash: 'x',
  createdAt: new Date().toISOString(),
  ...o,
});
async function save(o: Partial<Staff>): Promise<void> {
  await getAuthStore().saveStaff(mkStaff(o));
}
async function signInAs(o: Partial<Staff>): Promise<void> {
  await save(o);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(o.username!));
}
const render = async () => renderToStaticMarkup(await StaffPage());

beforeEach(async () => {
  redis.dump.clear();
  for (const k of [...redis.sets.keys()]) await redis.del(k); // the index sets live outside dump
  cookieJar.clear();
  box.db = await freshDb();
  pgPartnerStore = createPartnerStore(box.db);
  await seedPartner(box.db, 'pa');
  await seedPartner(box.db, 'pb');
});

describe('/partner/staff: the gate', () => {
  it('anonymous → /login', async () => {
    await expect(StaffPage()).rejects.toThrow('REDIRECT:/login');
  });
  it('platform staff → /admin-dashboard', async () => {
    await signInAs({ username: 'root', role: 'admin', partnerId: undefined });
    await expect(StaffPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('support and finance → /partner (admin and agent only)', async () => {
    for (const role of ['support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role, partnerId: 'pa' });
      await expect(StaffPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/staff: content', () => {
  beforeEach(async () => {
    await signInAs({ username: 'pa-admin', name: 'Alice Admin', role: 'admin', partnerId: 'pa', lastLoginAt: new Date().toISOString() });
    await save({ username: 'pa-agent', name: 'Andy Agent', role: 'agent', partnerId: 'pa' });
    await save({ username: 'pa-fin', name: 'Fiona Finance', role: 'finance', partnerId: 'pa', status: 'suspended' });
    await save({ username: 'pb-agent', name: 'Bob Otherco', role: 'agent', partnerId: 'pb' });
    await save({ username: 'platform-root', name: 'Pat Platform', role: 'admin', partnerId: undefined });
  });

  it("pa's admin sees pa's members and NOT pb's nor platform accounts", async () => {
    const html = await render();
    for (const s of ['Alice Admin', 'Andy Agent', 'Fiona Finance', 'pa-agent', 'pa-fin']) expect(html).toContain(s);
    for (const s of ['Bob Otherco', 'pb-agent', 'Pat Platform', 'platform-root']) expect(html).not.toContain(s);
    expect(html).toContain(t('partner.staff.role.finance'));
    expect(html).toContain(t('partner.staff.statusSuspended'));
    expect(html).toContain(t('partner.staff.justNow'));
    expect(html).toContain(t('partner.staff.never'));
  });

  it('MFA "on" for an enrolled member, "off" for the others', async () => {
    const mfa = createStaffMfaStore(redis);
    expect(await mfa.isEnrolled('pa-agent')).toBe(false);
    await redis.set('staff_mfa:pa-agent', JSON.stringify({ secretEnc: 'sealed', enrolledAt: new Date().toISOString() }));
    expect(await mfa.isEnrolled('pa-agent')).toBe(true);
    const html = await render();
    const row = (u: string) => html.slice(html.indexOf(`>${u}<`), html.indexOf('</tr>', html.indexOf(`>${u}<`)));
    expect(row('pa-agent')).toContain(t('partner.staff.mfaOn'));
    expect(row('pa-admin')).toContain(t('partner.staff.mfaOff'));
  });

  it('pending invites of THIS tenant only: username, role, expiry; never an email or a token', async () => {
    const store = createStaffInviteStore(redis);
    const own = await store.issue({ partnerId: 'pa', username: 'pa-invitee', name: 'Ivy Invitee', role: 'support', invitedBy: 'pa-admin' });
    const foreign = await store.issue({ partnerId: 'pb', username: 'pb-invitee', name: 'X', role: 'agent', invitedBy: 'pb-admin' });
    if ('error' in own || 'error' in foreign) throw new Error();
    const html = await render();
    expect(html).toContain('pa-invitee');
    expect(html).not.toContain('pb-invitee');
    expect(html).not.toContain(own.token);
    expect(html).not.toContain(own.hash);
    expect(html).toContain(own.expiresAt.slice(0, 10));
    expect(html).not.toMatch(/@example\./);
  });

  it('empty invites state', async () => {
    expect(await render()).toContain(t('partner.staff.invitesEmpty'));
  });

  it('no tenant field anywhere; no MFA-reset control; the invite form is present', async () => {
    const html = await render();
    expect(html).not.toMatch(/name="(partnerId|partner|tenant)"/);
    expect(html).not.toMatch(/reset/i);
    expect(html).toContain('data-testid="partner-staff-invite-form"');
    expect(html).toContain('name="email"');
    for (const role of ['admin', 'agent', 'support', 'finance']) expect(html).toContain(`value="${role}"`);
  });

  it('no Remove control on your own row', async () => {
    const html = await render();
    expect(html).not.toContain(t('partner.staff.removeName', { name: 'Alice Admin' }));
    expect(html).toContain(t('partner.staff.removeName', { name: 'Andy Agent' }));
  });
});

// Lost-features A13: the agent view is a read-only roster. Nothing an admin manages is read or shown.
describe('/partner/staff: the agent view', () => {
  beforeEach(async () => {
    await save({ username: 'pa-admin', name: 'Alice Admin', role: 'admin', partnerId: 'pa', lastLoginAt: new Date().toISOString() });
    await signInAs({ username: 'pa-agent', name: 'Andy Agent', role: 'agent', partnerId: 'pa' });
    await save({ username: 'pa-fin', name: 'Fiona Finance', role: 'finance', partnerId: 'pa', status: 'suspended' });
    await save({ username: 'pb-agent', name: 'Bob Otherco', role: 'agent', partnerId: 'pb' });
    await redis.set('staff_mfa:pa-admin', JSON.stringify({ secretEnc: 'sealed', enrolledAt: new Date().toISOString() }));
    const inv = await createStaffInviteStore(redis).issue({ partnerId: 'pa', username: 'pa-invitee', name: 'Ivy', role: 'support', invitedBy: 'pa-admin' });
    if ('error' in inv) throw new Error();
  });
  it("names and roles of the tenant's ACTIVE members; no other tenant, no suspended member", async () => {
    const html = await render();
    for (const s of ['Alice Admin', 'pa-admin', 'Andy Agent', t('partner.staff.role.admin')]) expect(html).toContain(s);
    for (const s of ['Fiona Finance', 'pa-fin', 'Bob Otherco', 'pb-agent']) expect(html).not.toContain(s);
    expect(html).toContain(t('partner.staff.subAgent'));
  });
  it('no MFA state, last sign-in, invites, invite form or Remove control', async () => {
    const html = await render();
    for (const s of [t('partner.staff.mfaOn'), t('partner.staff.mfaOff'), t('partner.staff.colLastLogin'), t('partner.staff.justNow'), t('partner.staff.invitesTitle'), 'pa-invitee', t('partner.staff.inviteTitle'), t('partner.staff.colActions')]) {
      expect(html, s).not.toContain(s);
    }
    expect(html).not.toContain('data-testid="partner-staff-invite-form"');
    expect(html).not.toContain(t('partner.staff.removeName', { name: 'Alice Admin' }));
    expect(html).not.toContain(t('partner.staff.statusActive'));
  });
});
