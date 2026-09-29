import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-18, Task 18.2: the partner's one-time slug claim (/partner/branding). Real gate
// (requirePartnerStaff over the real auth store on a fake Redis), real writer on PGlite. The shared
// per-action checklist, plus: claim once, no oracle, the per-partner throttle before any DB read.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
// Spies over the REAL repo functions, so "no DB read" is asserted on the slug reads themselves.
const repoSpy = vi.hoisted(() => ({ getPartnerSite: vi.fn(), setPartnerSlug: vi.fn() }));
vi.mock('@/db/repos/partner-site-repo', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/partner-site-repo')>('@/db/repos/partner-site-repo');
  return { ...actual, getPartnerSite: repoSpy.getPartnerSite, setPartnerSlug: repoSpy.setPartnerSlug };
});
const realRepo = await vi.importActual<typeof import('@/db/repos/partner-site-repo')>('@/db/repos/partner-site-repo');

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { auditEvents, partners, partnerSites, partnerSlugTombstones } from '@/db/schema';
import { claimSlugAction } from '@/app/partner/(app)/branding/slug-actions';
import { t } from '@/lib/i18n';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function signInAs(o: Partial<Staff>): Promise<Staff> {
  const s: Staff = {
    username: 'pa-admin',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    partnerId: PA,
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  return s;
}

function form(values: Record<string, string | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const claimForm = (slug = 'alpha-co', extra: Record<string, string> = {}) => form({ slug, ...extra });

const audits = () => db.select().from(auditEvents);
const siteOf = async (id: string) => (await db.select().from(partnerSites).where(eq(partnerSites.partnerId, id)))[0] ?? null;
const snapshot = async () => ({
  sites: await db.select().from(partnerSites),
  tombstones: await db.select().from(partnerSlugTombstones),
  audits: (await audits()).length,
});
const FINANCE_REDIRECT = (KNOWN_PARTNER_ROLES as readonly string[]).includes('finance') ? 'REDIRECT:/partner' : 'REDIRECT:/login';
const UNAVAILABLE = { ok: false, error: t('partner.slug.unavailable') };

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  vi.clearAllMocks();
  // Re-armed every test: restoreAllMocks (afterEach) resets a vi.fn's implementation.
  repoSpy.getPartnerSite.mockImplementation(realRepo.getPartnerSite);
  repoSpy.setPartnerSlug.mockImplementation(realRepo.setPartnerSlug);
});
afterEach(() => vi.restoreAllMocks());

describe('claimSlugAction: per-action checklist', () => {
  it('0. refuses on a partner-site host before anything else', async () => {
    await signInAs({});
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(claimSlugAction(claimForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
  });
  it('1. anonymous → /login; platform staff → /admin-dashboard', async () => {
    await expect(claimSlugAction(claimForm())).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(claimSlugAction(claimForm())).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await audits()).toHaveLength(0);
  });
  it('2. agent, support and finance → /partner with no DB change', async () => {
    const before = await snapshot();
    for (const role of ['agent', 'support'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(claimSlugAction(claimForm())).rejects.toThrow('REDIRECT:/partner');
    }
    await signInAs({ username: 'pa-fin', role: 'finance' as Staff['role'] });
    await expect(claimSlugAction(claimForm())).rejects.toThrow(FINANCE_REDIRECT);
    expect(await snapshot()).toEqual(before);
  });
  it('2b. an admin with MFA enrolment pending → /partner/security?enroll=1 with no DB change', async () => {
    await signInAs({});
    await redis.set(`${MFA_PENDING_PREFIX}pa-admin`, '1');
    const before = await snapshot();
    await expect(claimSlugAction(claimForm())).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    expect(await snapshot()).toEqual(before);
  });
  it('3+4. a form naming partner B (id, partnerId, partner) claims for A only; B untouched', async () => {
    await signInAs({});
    const r = await claimSlugAction(claimForm('alpha-co', { id: PB, partnerId: PB, partner: PB }));
    expect(r).toEqual({ ok: true });
    expect(await siteOf(PA)).toMatchObject({ slug: 'alpha-co' });
    expect(await siteOf(PB)).toBeNull();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.partnerId).toBe(PA);
    expect(rows[0]!.subjectId).toBe(PA);
    expect(JSON.stringify(rows)).not.toContain(PB);
  });
  it('5. invalid input → the generic refusal, no write', async () => {
    await signInAs({});
    const before = await snapshot();
    expect(await claimSlugAction(claimForm('no_underscores'))).toEqual(UNAVAILABLE);
    expect(await snapshot()).toEqual(before);
  });
  it('6. success → exactly one audit row: tenant, actor, partner.slug.claim, actorScope partner, no PII', async () => {
    await signInAs({});
    expect(await claimSlugAction(claimForm())).toEqual({ ok: true });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'pa-admin', actorType: 'staff', action: 'partner.slug.claim' });
    expect(rows[0]!.meta).toEqual({ slug: 'alpha-co', previousSlug: null, actorScope: 'partner' });
    expect(JSON.stringify(rows[0]!.meta)).not.toMatch(/\+?\d{10,}/);
    for (const [p] of revalidatePath.mock.calls) expect(String(p)).toMatch(/^\/partner(\/|$)/);
    expect(revalidatePath).toHaveBeenCalledWith('/partner/branding');
  });
});

describe('claimSlugAction: claim once, no oracle, throttle', () => {
  it('normalises case and surrounding spaces the way the host allowlist does (lowercase)', async () => {
    await signInAs({});
    expect(await claimSlugAction(claimForm('  Alpha-Co  '))).toEqual({ ok: true });
    expect(await siteOf(PA)).toMatchObject({ slug: 'alpha-co' });
  });
  it('a second claim is refused with the contact-SmartRemit message and writes nothing', async () => {
    await signInAs({});
    expect(await claimSlugAction(claimForm('alpha-co'))).toEqual({ ok: true });
    const before = await snapshot();
    repoSpy.setPartnerSlug.mockClear();
    expect(await claimSlugAction(claimForm('alpha-two'))).toEqual({ ok: false, error: t('partner.slug.contactSmartRemit') });
    expect(repoSpy.setPartnerSlug).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
  it('reserved, taken, tombstoned and invalid slugs all get the byte-identical response and write nothing', async () => {
    await db.insert(partnerSites).values({ partnerId: PB, slug: 'bravo-co' });
    await db.insert(partnerSlugTombstones).values({ slug: 'old-bravo', partnerId: PB, releasedBy: 'ops' });
    await signInAs({});
    const before = await snapshot();
    const results: unknown[] = [];
    // 8 here + 2 below = exactly the 10-an-hour budget.
    for (const s of ['www', 'bravo-co', 'old-bravo', 'xn--abc', 'ab', '-edge', 'a'.repeat(31), 'bad slug']) {
      results.push(await claimSlugAction(claimForm(s)));
    }
    results.push(await claimSlugAction(form({ slug: new File(['x'], 'x.txt') })));
    results.push(await claimSlugAction(form({})));
    for (const r of results) expect(JSON.stringify(r)).toBe(JSON.stringify(UNAVAILABLE));
    expect(await snapshot()).toEqual(before);
  });
  it('an oversized input is refused without reaching the writer', async () => {
    await signInAs({});
    expect(await claimSlugAction(claimForm('a'.repeat(5000)))).toEqual(UNAVAILABLE);
    expect(repoSpy.setPartnerSlug).not.toHaveBeenCalled();
  });
  it('the 11th attempt in an hour is throttled with no slug read or write', async () => {
    await signInAs({});
    for (let i = 0; i < 10; i++) expect(await claimSlugAction(claimForm('www'))).toEqual(UNAVAILABLE);
    repoSpy.getPartnerSite.mockClear();
    repoSpy.setPartnerSlug.mockClear();
    expect(await claimSlugAction(claimForm('alpha-co'))).toEqual({ ok: false, error: t('partner.slug.throttled') });
    expect(repoSpy.getPartnerSite).not.toHaveBeenCalled();
    expect(repoSpy.setPartnerSlug).not.toHaveBeenCalled();
    expect(await siteOf(PA)).toBeNull();
  });
  it('the throttle is per partner: B is not slowed by A', async () => {
    await signInAs({});
    for (let i = 0; i < 11; i++) await claimSlugAction(claimForm('www'));
    await signInAs({ username: 'pb-admin', partnerId: PB });
    expect(await claimSlugAction(claimForm('bravo-co'))).toEqual({ ok: true });
  });
  it('a throttle-store outage refuses (fail closed) with the generic failure copy, no write', async () => {
    await signInAs({});
    const incr = redis.incr;
    redis.incr = async () => {
      throw new Error('down');
    };
    try {
      expect(await claimSlugAction(claimForm())).toEqual({ ok: false, error: t('partner.branding.failed') });
    } finally {
      redis.incr = incr;
    }
    expect(await siteOf(PA)).toBeNull();
  });
  it('a writer error is the generic failure copy, never the message', async () => {
    await signInAs({});
    repoSpy.setPartnerSlug.mockRejectedValueOnce(new Error('db down secret-detail'));
    const r = await claimSlugAction(claimForm());
    expect(r).toEqual({ ok: false, error: t('partner.branding.failed') });
    expect(JSON.stringify(r)).not.toContain('secret-detail');
  });
  it('a workspace that vanished → the not-found copy', async () => {
    await signInAs({});
    repoSpy.setPartnerSlug.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect(await claimSlugAction(claimForm())).toEqual({ ok: false, error: t('partner.branding.notFound') });
  });
  it('losing a same-partner race inside the writer (already_claimed) → the contact message', async () => {
    await signInAs({});
    repoSpy.setPartnerSlug.mockResolvedValueOnce({ ok: false, reason: 'already_claimed' });
    expect(await claimSlugAction(claimForm())).toEqual({ ok: false, error: t('partner.slug.contactSmartRemit') });
  });
});
