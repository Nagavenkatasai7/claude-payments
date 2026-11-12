/**
 * Fix pack 7 T17 (P15 queue half): /partner/reviews for a queue partner
 * (holdQueueApplies: certified, posture holdDecider 'partner') groups the held
 * rows by hold class and state, oldest first, each linking to its transfer
 * page. Every other partner keeps today's held section (TransferRows) and
 * never reads hold_reviews.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer, signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import type { Db } from '@/db/client';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let store: Store;
let pgPartnerStore: PartnerStore;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
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
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/kyc-case-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kyc-case-store')>('@/lib/kyc-case-store');
  const cs = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getKycCaseStore: (s: Store) => actual.createKycCaseStore(redis, cs.createCustomerStore(db, s)) };
});
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));
// Spies listForQueue (tenant, ids) and makes it throw on demand (test 11).
const repoSpy = vi.hoisted(() => ({ calls: [] as Array<{ partnerId: string; ids: string[] }>, fail: false }));
vi.mock('@/db/repos/hold-review-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/hold-review-repo')>();
  return {
    ...real,
    createHoldReviewRepo: (...a: Parameters<typeof real.createHoldReviewRepo>) => {
      const repo = real.createHoldReviewRepo(...a);
      return {
        ...repo,
        listForQueue: async (partnerId: string, ids: readonly string[]) => {
          repoSpy.calls.push({ partnerId, ids: [...ids] });
          if (repoSpy.fail) {
            const err = new Error('select failed: secret detail 15551239876 tr_qkyc1');
            err.name = 'NeonDbError';
            throw err;
          }
          return repo.listForQueue(partnerId, ids);
        },
      };
    },
  };
});

import ReviewsPage from '@/app/partner/(app)/reviews/page';
import { createHoldReviewRepo } from '@/db/repos/hold-review-repo';
import { classReasonsFp, classifyHold } from '@/lib/hold-queue';
import { LARGE_AMOUNT_REASON } from '@/lib/compliance-config';
import { t } from '@/lib/i18n';

const render = async () => renderToStaticMarkup(await ReviewsPage());
const asAdmin = (partnerId: string) => signInAs(redis, cookieJar, { username: `${partnerId}-admin`, partnerId, role: 'admin' });

/** The (class, state, ids) of every queue group, in page order. */
function groups(html: string) {
  const out: Array<{ holdClass: string; state: string; ids: string[] }> = [];
  const re = /<div data-testid="partner-hold-queue-group" data-class="([a-z_]+)" data-state="([a-z_]+)">([\s\S]*?)<\/ul><\/div>/g;
  for (const m of html.matchAll(re)) {
    out.push({ holdClass: m[1], state: m[2], ids: [...m[3].matchAll(/href="\/partner\/transfers\/([^"]+)"/g)].map((x) => x[1]) });
  }
  return out;
}

/** A non-final step-1 kyc row under the row's current class fingerprint. */
async function kycStep1(partnerId: string, transferId: string) {
  const c = classifyHold([LARGE_AMOUNT_REASON], undefined, { queue: true, partnerDecidesKyc: true })[0];
  const r = await createHoldReviewRepo(db).insert({
    transferId, partnerId, holdClass: 'kyc', reasonsFp: classReasonsFp(c), step: 1, final: false,
    disposition: 'documents_verified', reason: 'Payslips checked against the stated income.', evidence: {},
    actor: 'co-a', actorScope: 'partner',
  });
  if (!r) throw new Error('kycStep1: refused');
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  logWarnSpy.mockClear();
  repoSpy.calls.length = 0;
  repoSpy.fail = false;
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
});

describe('/partner/reviews hold queue (T17, P15)', { retry: 0 }, () => {
  it('9. queue partner: one group per (class, state) with labels, age and links; no TransferRows table', async () => {
    await certifiedQueuePartner(db, { partnerId: 'acme' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc1' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc2' });
    await heldRowFor(db, 'acme', 'aml', { id: 'tr_qaml1' });
    await heldRowFor(db, 'acme', 'list_wait', { id: 'tr_qlist1' });
    await heldRowFor(db, 'acme', 'sanctions_review', { id: 'tr_qsan1' });
    await kycStep1('acme', 'tr_qkyc2');
    await asAdmin('acme');
    const html = await render();
    expect(groups(html)).toEqual([
      { holdClass: 'kyc', state: 'awaiting_second', ids: ['tr_qkyc2'] },
      { holdClass: 'kyc', state: 'awaiting_first', ids: ['tr_qkyc1'] },
      { holdClass: 'aml', state: 'awaiting_first', ids: ['tr_qaml1'] },
      { holdClass: 'sanctions_review', state: 'waits_smartremit', ids: ['tr_qsan1'] },
      { holdClass: 'list_wait', state: 'waits_list', ids: ['tr_qlist1'] },
    ]);
    // React escapes nothing in these labels; the separator is a middle dot.
    expect(html).toContain(`${t('partner.holdDecision.class.kyc')} · ${t('partner.holdDecision.state.awaiting_second')}`);
    expect(html).toContain(`${t('partner.holdDecision.class.aml')} · ${t('partner.holdDecision.state.awaiting_first')}`);
    expect(html).toContain(`${t('partner.holdDecision.class.list_wait')} · ${t('partner.holdDecision.state.waits_list')}`);
    expect(html).toContain(t('partner.holdDecision.state.waits_smartremit'));
    expect(html).toContain(t('partner.reviews.held.age', { n: 0 }));
    expect(html).toContain('href="/partner/transfers/tr_qkyc1"');
    // The queue shows ids, class, state and age only (no TransferRows table, no amount or phone).
    expect(html).not.toContain(t('partner.reviews.held.caption'));
    expect(html).not.toContain('15551239876');
    expect(html).not.toContain('9876');
    expect(html).not.toContain('Test Recipient');
    expect(html).toContain('data-testid="partner-reviews-held"');
    expect(html).toContain('data-kpi="held">5<');
    expect(repoSpy.calls).toHaveLength(1);
    expect(repoSpy.calls[0].partnerId).toBe('acme');
    expect(logWarnSpy).not.toHaveBeenCalled();
  });

  it('10. rows and reviews of another tenant never appear; listForQueue gets own ids only', async () => {
    await certifiedQueuePartner(db, { partnerId: 'acme' });
    await certifiedQueuePartner(db, { partnerId: 'beta' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc1' });
    await heldRowFor(db, 'beta', 'kyc', { id: 'tr_bkyc1' });
    await kycStep1('beta', 'tr_bkyc1');
    await asAdmin('acme');
    const html = await render();
    expect(groups(html)).toEqual([{ holdClass: 'kyc', state: 'awaiting_first', ids: ['tr_qkyc1'] }]);
    expect(html).not.toContain('tr_bkyc1');
    expect(repoSpy.calls).toEqual([{ partnerId: 'acme', ids: ['tr_qkyc1'] }]);
  });

  it('11. a hold_reviews read that throws -> logWarn once (no row content), today\'s TransferRows list', async () => {
    await certifiedQueuePartner(db, { partnerId: 'acme' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc1' });
    repoSpy.fail = true;
    await asAdmin('acme');
    const html = await render();
    expect(groups(html)).toEqual([]);
    expect(html).not.toContain('partner-hold-queue-group');
    expect(html).toContain(t('partner.reviews.held.caption'));
    expect(html).toContain('tr_qkyc1');
    const queueWarns = logWarnSpy.mock.calls.filter((c) => c[0] === 'partner.reviews.queue');
    expect(queueWarns).toEqual([['partner.reviews.queue', 'NeonDbError', { partnerId: 'acme' }]]);
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toMatch(/15551239876|secret detail|tr_qkyc1/);
  });

  it('12. uncertified delegated partner: today\'s held section, hold_reviews never read', async () => {
    await seedPartner(db, 'pa', 'Partner A');
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'pa'`);
    await seedPartnerTransfer(db, { id: 'tr_heldA1', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await asAdmin('pa');
    const html = await render();
    expect(html).toContain(t('partner.reviews.held.caption'));
    expect(html).toContain('tr_heldA1');
    expect(html).not.toContain('partner-hold-queue-group');
    expect(html).not.toContain(t('partner.reviews.held.age', { n: 0 }));
    expect(repoSpy.calls).toEqual([]);
  });

  it("13. certified partner with holdDecider 'smartremit_delegated': no queue groups (owner question 1)", async () => {
    await certifiedQueuePartner(db, { partnerId: 'acme', holdDecider: 'smartremit_delegated' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc1' });
    await asAdmin('acme');
    const html = await render();
    expect(html).not.toContain('partner-hold-queue-group');
    expect(html).toContain(t('partner.reviews.held.caption'));
    expect(repoSpy.calls).toEqual([]);
  });

  it('14. the tile count is unchanged (held.length), with and without the queue', async () => {
    await certifiedQueuePartner(db, { partnerId: 'acme' });
    await heldRowFor(db, 'acme', 'kyc', { id: 'tr_qkyc1' });
    await heldRowFor(db, 'acme', 'aml', { id: 'tr_qaml1' });
    await asAdmin('acme');
    expect(await render()).toContain('data-kpi="held">2<');
    repoSpy.fail = true;
    expect(await render()).toContain('data-kpi="held">2<');
  });
});
