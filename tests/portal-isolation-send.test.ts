import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Db } from '@/db/client';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { resetRateCacheForTests, FX_MAX_AGE_MS } from '@/lib/rate';
import { newRequestKey } from '@/lib/portal-request-key';
import { recipientRid } from '@/lib/portal-recipients';
import { loadSendReview, markReviewDrafted, reviewNotice, saveSendReview, type SendFormValue } from '@/lib/portal-send';
import type { ToolContextDeps } from '@/lib/tool-context';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-9: tenant isolation of the portal Send flow, with the shared two-partner fixture (the
// SAME phone is a customer of partner A 'pa' and partner B 'pb'). The partner is always the HOST's:
// A's review, recipients, transfers and drafts never act on B's host, and a crafted draft id is
// never taken as the customer's.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  ps: null as unknown,
  deps: {} as Record<string, unknown>,
}));

vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.ctx,
  requirePortalCustomer: async () => h.ctx,
  requireFreshPortalAuth: async () => h.ctx,
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));
vi.mock('@/lib/tool-context', async (orig) => {
  const actual = await orig<typeof import('@/lib/tool-context')>();
  return {
    ...actual,
    buildToolContext: (args: Parameters<typeof actual.buildToolContext>[0]) =>
      actual.buildToolContext({ ...args, deps: { ...(h.deps as Partial<ToolContextDeps>), ...args.deps } }),
  };
});

import { continueToPayAction, sendAgainAction, startSendReviewAction } from '@/app/portal/send/actions';

let db: Db;
let redis: FakeRedis;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;

const onHost = (partnerId: string) => {
  h.site = { partnerId, slug: partnerId, brand: `Brand ${partnerId}`, logo: null, theme: {} };
  h.ctx = { site: h.site, session: { phone, sid: 's' }, token: 't', customer: { partnerId, senderPhone: phone } };
};
const fd = (f: Record<string, string> = {}) => {
  const x = new FormData();
  x.set('requestKey', newRequestKey());
  for (const [k, v] of Object.entries(f)) x.set(k, v);
  return x;
};
const value: SendFormValue = { amountSource: 120, sourceCurrency: 'USD', destinationCountry: 'IN', fundingMethod: 'bank_transfer', recipient: { kind: 'new', name: 'Mom', phone: '919876543210' } };
const redirectOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: Error) => x);
  if (!e?.message.startsWith('REDIRECT:')) throw new Error(`no redirect: ${e?.message}`);
  return e.message.slice(9);
};
const draftIds = () => [...redis.dump.keys()].filter((k) => k.startsWith('recipient_draft:')).map((k) => k.slice(16));

beforeEach(async () => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  Object.assign(h, { db, redis, store, ps: createPartnerStore(db) });
  h.deps = {
    store, customerStore, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: h.ps, kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
  };
  await customerStore.setFullNameIfUnset('pa', phone, 'Alex Rivera');
  await customerStore.setFullNameIfUnset('pb', phone, 'Alex Rivera');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('portal Send — tenant isolation', () => {
  it("A's review is invisible on B's host: Continue there finds nothing and drafts nothing", async () => {
    const rv = await saveSendReview(redis, { partnerId: 'pa', phone }, value);
    onHost('pb');
    expect(await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })))).toBe('/portal/send');
    expect(draftIds()).toHaveLength(0);
  });

  it("a draft made on B's host is B's (the host tenant), never A's", async () => {
    onHost('pb');
    const rv = await saveSendReview(redis, { partnerId: 'pb', phone }, value);
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const [id] = draftIds();
    expect((await createDraftStore(redis).getDraft(id))?.partnerId).toBe('pb');
    expect(await createDraftStore(redis).getActiveDraftId('pa', phone, 'web')).toBeNull();
  });

  it("A's saved recipient cannot be picked on B's host (and B's on A's)", async () => {
    onHost('pb');
    const ridA = recipientRid('pa', phone, A.recipientPhones[0]);
    const r = await startSendReviewAction({}, fd({ amount: '10', currency: 'USD', destination: 'IN', funding: 'bank_transfer', recipient: ridA }));
    expect(r.error).toBe('portal.send.recipient_not_found');
    expect(await loadSendReview(redis, { partnerId: 'pb', phone })).toBeNull();
    onHost('pa');
    const ridB = recipientRid('pb', phone, B.recipientPhones[0]);
    const r2 = await startSendReviewAction({}, fd({ amount: '10', currency: 'USD', destination: 'IN', funding: 'bank_transfer', recipient: ridB }));
    expect(r2.error).toBe('portal.send.recipient_not_found');
  });

  it("Send again on A's transfer from B's host → not found", async () => {
    onHost('pb');
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd());
    expect(r.error).toBe('portal.send.not_found');
    expect(draftIds()).toHaveLength(0);
  });
});

describe('crafted draft ids', () => {
  it("a draft id of B's (or a made-up one) in A's review is never treated as A's live draft", async () => {
    onHost('pb');
    const rvB = await saveSendReview(redis, { partnerId: 'pb', phone }, value);
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv: rvB })));
    const [bDraft] = draftIds();
    const ds = createDraftStore(redis);
    expect(await reviewNotice(ds, { partnerId: 'pa', phone }, { draftId: bDraft })).toBe('portal.send.quote_refreshed');
    expect(await reviewNotice(ds, { partnerId: 'pb', phone }, { draftId: bDraft })).toBeNull();
    expect(await reviewNotice(ds, { partnerId: 'pa', phone }, { draftId: 'madeUpDraft1' })).toBe('portal.send.quote_refreshed');
    expect(await reviewNotice(ds, { partnerId: 'pa', phone }, {})).toBeNull();
  });

  it('a stale rate on the draft → quote_refreshed', async () => {
    onHost('pa');
    const rv = await saveSendReview(redis, { partnerId: 'pa', phone }, value);
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const [id] = draftIds();
    const ds = createDraftStore(redis);
    expect(await reviewNotice(ds, { partnerId: 'pa', phone }, { draftId: id })).toBeNull();
    expect(await reviewNotice(ds, { partnerId: 'pa', phone }, { draftId: id }, Date.now() + FX_MAX_AGE_MS + 60_000)).toBe('portal.send.quote_refreshed');
  });

  it('markReviewDrafted refuses a malformed id and a review id from another tab', async () => {
    const owner = { partnerId: 'pa', phone };
    const rv = await saveSendReview(redis, owner, value);
    await markReviewDrafted(redis, owner, rv, '../../x');
    expect((await loadSendReview(redis, owner))?.draftId).toBeUndefined();
    await markReviewDrafted(redis, owner, 'f'.repeat(32), 'goodDraft12');
    expect((await loadSendReview(redis, owner))?.draftId).toBeUndefined();
  });
});
