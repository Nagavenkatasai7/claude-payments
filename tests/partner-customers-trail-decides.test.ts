/**
 * Fix pack 7 T28 (P25 partner trail, D8): /partner/customers/[ref] and /partner/reviews for a
 * partner that DECIDES KYC (partnerDecidesKyc). Only its qualified compliance users read the two
 * extra trail kinds (SmartRemit's recommendation with its reason; the team's PEP clear with the
 * actor) and the deciding note; any other viewer, and every other partner, reads today's five
 * slugs and today's texts. The reviews page's KYC sub-line names the partner's own decision.
 * Real gate (requirePartnerStaff over the real auth store on a fake Redis), real stores on PGlite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, seedComplianceUsers } from './helpers-hold';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let store: Store;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (s: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, s) };
});
vi.mock('@/lib/kyc-case-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kyc-case-store')>('@/lib/kyc-case-store');
  const cs = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getKycCaseStore: (s: Store) => actual.createKycCaseStore(redis, cs.createCustomerStore(db, s)) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
// Records the action list of every trail read (the page's ONE call).
const trailReads = vi.hoisted(() => ({ actions: [] as string[][] }));
vi.mock('@/db/repos/tenant-audit-repo', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/tenant-audit-repo')>();
  return {
    ...actual,
    listTenantAuditForSubject: (...a: Parameters<typeof actual.listTenantAuditForSubject>) => {
      trailReads.actions.push([...a[3]]);
      return actual.listTenantAuditForSubject(...a);
    },
  };
});

import CustomerDetailPage from '@/app/partner/(app)/customers/[ref]/page';
import ReviewsPage from '@/app/partner/(app)/reviews/page';
import { auditSubjectId, sealCustomerRef } from '@/lib/customer-ref';
import { KYC_TRAIL_ACTIONS, KYC_TRAIL_READ_ACTIONS } from '@/lib/partner-kyc-trail';
import { t } from '@/lib/i18n';

const P = 'acme';
const U = 'beta'; // uncertified, kycMode 'delegated'
const PHONE = '15551230000';
const REC_REASON = 'Selfie and document match the declared identity.';
const PLATFORM_USER = 'owner-admin';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const seedCustomer = (partnerId: string) => {
  const iso = ago(3 * 86_400_000).toISOString();
  return createCustomerStore(db, store).saveCustomer({
    senderPhone: PHONE,
    firstSeenAt: iso,
    kycStatus: 'pending',
    kycReviewState: 'pending_review',
    senderCountry: 'US',
    partnerId,
    createdAt: iso,
    updatedAt: iso,
  } as Customer);
};
/** A SmartRemit recommendation and the team's own PEP clear, as T27 and clearPepInTx write them. */
const seedTrailRows = async (partnerId: string, clearer: string) => {
  const audit = createAuditRepo(db);
  const subjectId = auditSubjectId(partnerId, PHONE);
  await audit.record({ partnerId, actor: PLATFORM_USER, actorType: 'staff', action: 'kyc.recommend', subjectId, meta: { recommendation: 'approve', reason: REC_REASON } });
  await audit.record({
    partnerId,
    actor: clearer,
    actorType: 'staff',
    action: 'customer.screening_hold.clear',
    subjectId,
    meta: { flaggedAt: ago(HOUR).toISOString(), previousClearedAt: null, pepHit: true, watchlistHit: false, kycStatus: 'pending', actorScope: 'partner', via: 'kyc_decision' },
  });
};
const page = async (partnerId = P) =>
  renderToStaticMarkup(await CustomerDetailPage({ params: Promise.resolve({ ref: sealCustomerRef(partnerId, PHONE) }) }));

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  trailReads.actions = [];
  db = await freshDb();
  store = createStore(redis, db);
  await certifiedQueuePartner(db, { partnerId: P, kycMode: 'delegated', users: ['co-a'] });
  await seedCustomer(P);
  await seedTrailRows(P, 'co-a');
});

describe('/partner/customers/[ref] trail for a partner that decides KYC (T28)', { retry: 0 }, () => {
  it('9. a qualified co-a sees the recommendation, its reason, "PEP flag cleared · co-a" and the deciding note; no platform username', async () => {
    await seedComplianceUsers(db, P, ['co-a'], { redis });
    await signInAs(redis, cookieJar, { username: 'co-a', name: 'Compliance co-a', partnerId: P, role: 'agent' });
    const html = await page();
    expect(trailReads.actions).toEqual([[...KYC_TRAIL_READ_ACTIONS]]);
    expect(html).toContain(t('partner.customers.trail.recommendApprove'));
    expect(html).toContain('data-trail="recommendApprove"');
    expect(html).toContain(REC_REASON);
    expect(html).toContain('data-trail="pepCleared"');
    const cleared = html.match(/<li[^>]*data-trail="pepCleared"[^>]*>(.*?)<\/li>/)?.[1] ?? '';
    expect(cleared.replace(/<[^>]+>/g, '')).toMatch(new RegExp(`^${t('partner.customers.trail.pepCleared')} · co-a · `));
    expect(html).toContain(t('partner.customers.trail.noteDecides'));
    expect(html).not.toContain(PLATFORM_USER);
  });

  it('10. an agent of the same partner who is NOT a listed compliance user: neither line, no reason text, today’s note', async () => {
    await seedComplianceUsers(db, P, ['agent-x'], { redis });
    await signInAs(redis, cookieJar, { username: 'agent-x', name: 'Agent x', partnerId: P, role: 'agent' });
    const html = await page();
    expect(trailReads.actions).toEqual([[...KYC_TRAIL_ACTIONS]]);
    expect(html).not.toContain(t('partner.customers.trail.recommendApprove'));
    expect(html).not.toContain(t('partner.customers.trail.pepCleared'));
    expect(html).not.toContain(REC_REASON);
    expect(html).not.toContain('data-trail="recommendApprove"');
    expect(html).not.toContain(t('partner.customers.trail.noteDecides'));
    expect(html).toContain('data-testid="partner-kyc-trail"');
  });

  it('11. an uncertified delegated partner with the same rows: today’s read, neither line', async () => {
    await seedPartner(db, U);
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = ${U}`);
    await seedCustomer(U);
    await seedTrailRows(U, 'beta-admin');
    await signInAs(redis, cookieJar, { username: 'beta-admin', name: 'Beta admin', partnerId: U, role: 'admin' });
    const html = await page(U);
    expect(trailReads.actions).toEqual([[...KYC_TRAIL_ACTIONS]]);
    expect(html).not.toContain(t('partner.customers.trail.recommendApprove'));
    expect(html).not.toContain(t('partner.customers.trail.pepCleared'));
    expect(html).not.toContain(REC_REASON);
    expect(html).toContain(t('partner.customers.trail.note'));
    expect(html).not.toContain(t('partner.customers.trail.noteDecides'));
  });
});

describe('/partner/reviews KYC sub-line (T28)', { retry: 0 }, () => {
  const kycSection = (html: string) => {
    const i = html.indexOf('data-testid="partner-reviews-kyc"');
    expect(i).toBeGreaterThan(-1);
    return html.slice(Math.max(0, i - 2000), i + 2000);
  };

  it('12. the deciding partner: subPartnerDecides; an uncertified delegated partner: subDelegated as today', async () => {
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    let html = renderToStaticMarkup(await ReviewsPage());
    expect(html).toContain(t('partner.reviews.kyc.subPartnerDecides'));
    expect(kycSection(html)).not.toContain(t('partner.reviews.kyc.subDelegated'));

    await seedPartner(db, U);
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = ${U}`);
    cookieJar.clear();
    await signInAs(redis, cookieJar, { username: 'beta-admin', partnerId: U, role: 'admin' });
    html = renderToStaticMarkup(await ReviewsPage());
    expect(kycSection(html)).toContain(t('partner.reviews.kyc.subDelegated'));
    expect(html).not.toContain(t('partner.reviews.kyc.subPartnerDecides'));
  });
});
