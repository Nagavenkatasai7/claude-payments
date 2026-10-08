import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { resetRateCacheForTests } from '@/lib/rate';
import { payUrlFor } from '@/lib/pay-url';
import { newRequestKey } from '@/lib/portal-request-key';
import { recipientRid, deleteRecipientWithSchedules } from '@/lib/portal-recipients';
import { auditSubjectId } from '@/lib/customer-ref';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { loadSendReview, saveSendReview, PORTAL_SEND_LIMIT, type SendFormValue } from '@/lib/portal-send';
import type { ToolContextDeps } from '@/lib/tool-context';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedSender } from './helpers-db';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-9, Tasks 9.2-9.4: the portal Send actions. Public POST endpoints: the host gate,
// the session, the 15-minute step-up, the per-customer limit, then the bot's own KYC gate (pure reads),
// cap + EDD pre-check (check_send_limit) and ONE draft through prepareSendDraft (the web pointer),
// replay-safe by request key. The portal never mints: the redirect is the existing pay page.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  stale: false,
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
  requirePortalCustomer: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
  requireFreshPortalAuth: async (returnTo: string) => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    if (h.stale) throw new Error(`REDIRECT:/portal/verify?next=${returnTo}`);
    return h.ctx;
  },
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'pa.smartremit.ai', 'x-forwarded-for': '203.0.113.9' }) }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));
// The tool context's singletons are process-cached; every build here uses THIS test's stores.
vi.mock('@/lib/tool-context', async (orig) => {
  const actual = await orig<typeof import('@/lib/tool-context')>();
  return {
    ...actual,
    buildToolContext: (args: Parameters<typeof actual.buildToolContext>[0]) =>
      actual.buildToolContext({ ...args, deps: { ...(h.deps as Partial<ToolContextDeps>), ...args.deps } }),
  };
});
const prepareSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/send-seam', async (orig) => {
  const actual = await orig<typeof import('@/lib/send-seam')>();
  return {
    ...actual,
    prepareSendDraft: (...a: Parameters<typeof actual.prepareSendDraft>) => {
      prepareSpy(a[1], a[2]);
      return actual.prepareSendDraft(...a);
    },
  };
});

import { continueToPayAction, sendAgainAction, setSenderNameAction, startSendReviewAction } from '@/app/portal/send/actions';

const SITE = (partnerId: string) => ({ partnerId, slug: partnerId, brand: `Brand ${partnerId}`, logo: null, theme: {} });
const MOM = '919876543210';

let db: Db;
let redis: FakeRedis;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;
let startSpy: { mock: { calls: unknown[][] } };

function signIn(partnerId: string, p: string) {
  h.site = SITE(partnerId);
  h.ctx = { site: h.site, session: { phone: p, sid: 's1' }, token: 'tok', customer: { partnerId, senderPhone: p } };
}

function fd(fields: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set('requestKey', newRequestKey());
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const newRecipient: SendFormValue = {
  amountSource: 200,
  sourceCurrency: 'USD',
  destinationCountry: 'IN',
  fundingMethod: 'bank_transfer',
  recipient: { kind: 'new', name: 'Mom', phone: MOM },
  purpose: 'education',
};

async function review(partnerId: string, v: SendFormValue = newRecipient): Promise<string> {
  return saveSendReview(redis, { partnerId, phone }, v);
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: Error) => e);
  if (!err || !String(err.message).startsWith('REDIRECT:')) throw new Error(`expected a redirect, got ${err ? err.message : JSON.stringify(await p)}`);
  return err.message.slice('REDIRECT:'.length);
}

const drafts = () => [...redis.dump.keys()].filter((k) => k.startsWith('recipient_draft:'));
const auditRows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
// A customer raise to $10,000/day, so a month's spend landing today trips EDD without the daily cap.
const raiseDaily = () => db.execute(sql`UPDATE customers SET send_limit_override = '{"t1DailyCapCents":1000000,"perTransferCapCents":1000000}'::jsonb WHERE partner_id = 'pa'`);
const gateOn = (id = 'pa') => db.execute(sql`UPDATE partners SET require_kyc_before_send = true WHERE id = ${id}`);

beforeEach(async () => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  h.db = db;
  h.redis = redis;
  h.store = store;
  h.ps = createPartnerStore(db);
  h.deps = {
    store,
    customerStore,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: h.ps,
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
  };
  await customerStore.setFullNameIfUnset('pa', phone, 'Alex Rivera');
  await customerStore.setFullNameIfUnset('pb', phone, 'Alex Rivera');
  h.stale = false;
  prepareSpy.mockClear();
  startSpy = vi.spyOn(MockKycProvider.prototype, 'startVerification');
  signIn('pa', phone);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('continueToPayAction — gates', () => {
  it('apex / portal off → 404 before anything', async () => {
    h.site = null;
    await expect(continueToPayAction({ requestKey: newRequestKey() }, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('(4) a stale session → the step-up page, back to the review; no draft', async () => {
    const rv = await review('pa');
    h.stale = true;
    expect(await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })))).toBe('/portal/verify?next=/portal/send/review');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('no review in progress → back to the Send page', async () => {
    expect(await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv: 'a'.repeat(32) })))).toBe('/portal/send');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('another tab replaced the review → "changed", no draft', async () => {
    const old = await review('pa');
    await review('pa', { ...newRecipient, amountSource: 300 });
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv: old }));
    expect(r.error).toBe('portal.send.changed');
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});

describe('continueToPayAction — the draft', () => {
  it('(8) happy path: ONE web draft, the redirect is payUrlFor(draftId) with no phone or name; audited once', async () => {
    const rv = await review('pa');
    const url = await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    expect(drafts()).toHaveLength(1);
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(url).toBe(payUrlFor(draftId));
    expect(url).not.toContain(phone);
    expect(url).not.toContain(MOM);
    expect(url).not.toMatch(/mom/i);
    const rows = await auditRows('customer.send.draft');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'system:customer-portal', actorType: 'system', subjectId: auditSubjectId('pa', phone) });
    expect(rows[0].meta).toEqual({ draftId, via: 'send' });
    expect((await loadSendReview(redis, { partnerId: 'pa', phone }))?.draftId).toBe(draftId);
    // Required purpose: the review's purpose rides the draft (pay-finalize copies it onto the transfer).
    expect((await createDraftStore(redis).getDraft(draftId))?.purpose).toBe('education');
  });

  it('A3/A4: the reason rides the draft; a scam-pattern reason needs "I have read this warning" first', async () => {
    const rv = await review('pa', { ...newRecipient, purpose: 'other', purposeDetail: 'to claim my lottery prize' });
    const refused = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(refused.error).toBe('portal.send.scam_ack_required');
    expect(JSON.stringify(refused)).not.toMatch(/lottery|prize"|category/);
    expect(drafts()).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv, scam_ack: 'on' })));
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(await createDraftStore(redis).getDraft(draftId)).toMatchObject({ purpose: 'other', purposeDetail: 'to claim my lottery prize' });
  });

  it('A3: a plain reason needs no tick and rides the draft', async () => {
    const rv = await review('pa', { ...newRecipient, purpose: 'education', purposeDetail: 'school fees for my son' });
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(await createDraftStore(redis).getDraft(draftId)).toMatchObject({ purpose: 'education', purposeDetail: 'school fees for my son' });
  });

  it('(1) double submit (concurrent, same request key) → ONE draft, both go to the same pay link, ONE audit row', async () => {
    const rv = await review('pa');
    const f1 = fd({ rv });
    const f2 = fd({ rv });
    f2.set('requestKey', String(f1.get('requestKey')));
    const [u1, u2] = await Promise.all([
      redirectOf(continueToPayAction({ requestKey: '' }, f1)),
      redirectOf(continueToPayAction({ requestKey: '' }, f2)),
    ]);
    expect(u1).toBe(u2);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(drafts()).toHaveLength(1);
    expect(await auditRows('customer.send.draft')).toHaveLength(1);
  });

  it('M1: a second Continue on an already-drafted review (a NEW request key) makes no second draft', async () => {
    const rv = await review('pa');
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.already_sent');
    expect(drafts()).toHaveLength(1);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('two tabs on the same review (different request keys, concurrent) → ONE draft', async () => {
    const rv = await review('pa');
    const results = await Promise.allSettled([
      continueToPayAction({ requestKey: '' }, fd({ rv })),
      continueToPayAction({ requestKey: '' }, fd({ rv })),
    ]);
    expect(drafts()).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ error?: string }>).value.error);
    expect(refused).toEqual(['portal.send.already_sent']);
  });

  it('a refused Continue (e.g. sanctions) releases the review, so a corrected retry is not stuck', async () => {
    const rv = await review('pa', { ...newRecipient, recipient: { kind: 'new', name: 'John Doe', phone: MOM } });
    expect((await continueToPayAction({ requestKey: '' }, fd({ rv }))).error).toBe('portal.send.cannot_complete');
    expect((await continueToPayAction({ requestKey: '' }, fd({ rv }))).error).toBe('portal.send.cannot_complete');
  });

  it('(2) posted amount / rate / fee fields are ignored: the draft is the server re-quote of the stored review', async () => {
    const rv = await review('pa');
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv, amount: '1', amountSource: '1', rate: '999', fxRate: '999', fee: '0', fxFetchedAt: '1' })));
    const [input] = prepareSpy.mock.calls[0];
    expect(input.amountSource).toBe(200);
    const draft = await createDraftStore(redis).getDraft(drafts()[0].slice('recipient_draft:'.length));
    expect(draft?.amountSource).toBe(200);
    expect(draft?.quote?.fxRate).toBe(85);
    expect(draft?.quote?.fxFetchedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('(6) the WhatsApp pointer is untouched; the web pointer holds the draft', async () => {
    const rv = await review('pa');
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const ds = createDraftStore(redis);
    expect(await ds.getActiveDraftId('pa', phone)).toBeNull();
    expect(await ds.getActiveDraftId('pa', phone, 'web')).toBe(drafts()[0].slice('recipient_draft:'.length));
    expect(prepareSpy.mock.calls[0][1]).toEqual({ pointer: 'web' });
  });

  it('(11) no B2B / EDD smuggling: extra POST fields never reach the seam; the draft is a consumer send with the REVIEW\'s purpose', async () => {
    const rv = await review('pa');
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({
      rv, invoice_id: 'inv_1', invoiceId: 'inv_1', sender_business_name: 'X LLC', entity_type: 'business', entityType: 'business',
      source_of_funds: 'salary', sourceOfFunds: 'salary', occupation: 'engineer', relationship: 'family', purpose: 'family_support',
      recipient_legal_name: 'Z', funding: 'ach_pull', fundingMethod: 'ach_pull',
    })));
    const [input] = prepareSpy.mock.calls[0];
    expect(Object.keys(input).sort()).toEqual(['amountSource', 'destinationCountry', 'fundingMethod', 'purpose', 'recipientName', 'recipientPhone', 'sourceCurrency']);
    expect(input.fundingMethod).toBe('bank_transfer');
    expect(input.purpose).toBe('education'); // the stored review's, never the posted 'family_support'
    const draft = await createDraftStore(redis).getDraft(drafts()[0].slice('recipient_draft:'.length));
    expect(draft?.transferType).toBeUndefined();
    expect(draft?.sourceOfFunds).toBeUndefined();
    expect(draft?.invoiceId).toBeUndefined();
  });

  it('(5) a sanctions hit → neutral copy, no draft, and the blocked row (the draft screen ran)', async () => {
    const rv = await review('pa', { ...newRecipient, recipient: { kind: 'new', name: 'John Doe', phone: MOM } });
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.cannot_complete');
    expect(JSON.stringify(r)).not.toMatch(/sanction|ofac|match/i);
    expect(drafts()).toHaveLength(0);
    const blocked = (await createStore(redis, db).listTransfers()).filter((t) => t.status === 'blocked' && t.partnerId === 'pa');
    expect(blocked).toHaveLength(1);
    expect(r.requestKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a saved recipient (by rid) is resolved inside the own book', async () => {
    const rid = recipientRid('pa', phone, A.recipientPhones[0]);
    const rv = await review('pa', { ...newRecipient, recipient: { kind: 'saved', rid } });
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const [input] = prepareSpy.mock.calls[0];
    expect(input.recipientPhone).toBe(A.recipientPhones[0]);
    expect(input.recipientName).toBe('Recipient PA');
  });
});

describe('continueToPayAction — refusals before the seam', () => {
  it('(3) a forged rid from partner B → "not found", no draft', async () => {
    const ridB = recipientRid('pb', phone, B.recipientPhones[0]);
    const rv = await review('pa', { ...newRecipient, recipient: { kind: 'saved', rid: ridB } });
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.recipient_not_found');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('a recipient deleted between review and Continue (tombstone) → "not found", no draft', async () => {
    const rid = recipientRid('pa', phone, A.recipientPhones[0]);
    const rv = await review('pa', { ...newRecipient, recipient: { kind: 'saved', rid } });
    await deleteRecipientWithSchedules(db, 'pa', phone, rid);
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.recipient_not_found');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('(7)(12) KYC gate: an unverified customer → the verify card; NO provider inquiry, no draft', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    const rv = await review('pa');
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.kyc).toBe('verify');
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('KYC gate: a REJECTED customer → contact the partner (no verify retry)', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'rejected' });
    const rv = await review('pa');
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.kyc).toBe('contact');
    expect(r.error).toBe('portal.send.contact_partner');
    expect(r.vars).toEqual({ brand: 'Brand pa' });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('gate OFF and rejected (Suspended) → the contact copy too, never "verify"', async () => {
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'rejected' });
    const rv = await review('pa');
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.contact_partner');
    expect(r.kyc).toBe('contact');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('(10) EDD on a direct POST (no review render) → the WhatsApp copy, the seam is NOT called', async () => {
    await raiseDaily();
    await seedLedgerSpend(db, { partnerId: 'pa', phone, amountUsd: 2850, status: 'paid' });
    const rv = await review('pa', { ...newRecipient, amountSource: 200 });
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.edd_whatsapp');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('(10) over the cap on a direct POST → the cap copy with the limit, the seam is NOT called', async () => {
    const rv = await review('pa', { ...newRecipient, amountSource: 2800 });
    await seedLedgerSpend(db, { partnerId: 'pa', phone, amountUsd: 500, status: 'paid' });
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.cap_daily');
    expect(r.vars?.remaining).toMatch(/\$/);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('(9) the rate limit: the 21st in an hour refuses without calling the seam', async () => {
    for (let i = 0; i < PORTAL_SEND_LIMIT.limit; i++) {
      await checkIpRateLimit(redis, PORTAL_SEND_LIMIT.scope, auditSubjectId('pa', phone), { limit: PORTAL_SEND_LIMIT.limit, windowSec: PORTAL_SEND_LIMIT.windowSec });
    }
    const rv = await review('pa');
    const r = await continueToPayAction({ requestKey: '' }, fd({ rv }));
    expect(r.error).toBe('portal.send.too_many');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('a malformed request key → failed copy with a fresh key, no draft', async () => {
    const rv = await review('pa');
    const f = fd({ rv });
    f.set('requestKey', 'nope');
    const r = await continueToPayAction({ requestKey: '' }, f);
    expect(r.error).toBe('portal.send.failed');
    expect(drafts()).toHaveLength(0);
  });
});

describe('startSendReviewAction', () => {
  const form = (over: Record<string, string> = {}) =>
    fd({ amount: '150', currency: 'USD', destination: 'IN', funding: 'bank_transfer', recipient: 'new', name: 'Mom', phone: MOM, purpose: 'medical', ...over });

  it('stores the review for THIS customer and goes to the review page (no PII in the URL)', async () => {
    expect(await redirectOf(startSendReviewAction({}, form()))).toBe('/portal/send/review');
    expect(await loadSendReview(redis, { partnerId: 'pa', phone })).toMatchObject({ amountSource: 150, recipient: { kind: 'new', name: 'Mom', phone: MOM }, purpose: 'medical' });
    expect(await loadSendReview(redis, { partnerId: 'pb', phone })).toBeNull();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('refuses B\'s rid, a tombstoned rid and ach_pull; field errors echo no secret', async () => {
    const ridB = recipientRid('pb', phone, B.recipientPhones[0]);
    expect((await startSendReviewAction({}, form({ recipient: ridB }))).error).toBe('portal.send.recipient_not_found');
    const rid = recipientRid('pa', phone, A.recipientPhones[0]);
    await deleteRecipientWithSchedules(db, 'pa', phone, rid);
    expect((await startSendReviewAction({}, form({ recipient: rid }))).error).toBe('portal.send.recipient_not_found');
    const r = await startSendReviewAction({}, form({ funding: 'ach_pull' }));
    expect(r.errors?.funding).toBe('portal.send.funding_invalid');
    expect(await loadSendReview(redis, { partnerId: 'pa', phone })).toBeNull();
  });

  it('required purpose: missing or unknown ⇒ the form error "Choose why you are sending this money.", nothing stored, the purpose echoed back', async () => {
    for (const purpose of ['', 'P1301', 'Medical']) {
      const r = await startSendReviewAction({}, form({ purpose }));
      expect(r.errors?.purpose, purpose).toBe('portal.send.purpose_invalid');
      expect(r.values?.purpose).toBe(purpose);
    }
    const noField = fd({ amount: '150', currency: 'USD', destination: 'IN', funding: 'bank_transfer', recipient: 'new', name: 'Mom', phone: MOM });
    expect((await startSendReviewAction({}, noField)).errors?.purpose).toBe('portal.send.purpose_invalid');
    expect(await loadSendReview(redis, { partnerId: 'pa', phone })).toBeNull();
  });

  it('apex → 404', async () => {
    h.site = null;
    await expect(startSendReviewAction({}, form())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  // Batch B follow-up A3: Other needs the customer's reason.
  it('Other with no or a nonsense reason ⇒ the reason error, nothing stored, the words echoed back', async () => {
    for (const purpose_detail of ['', 'send money', 'asdfgh qwerty']) {
      const r = await startSendReviewAction({}, form({ purpose: 'other', purpose_detail }));
      expect(r.errors?.purposeDetail, purpose_detail).toBe('portal.send.purpose_detail_invalid');
      expect(r.values?.purpose_detail).toBe(purpose_detail);
    }
    const long = await startSendReviewAction({}, form({ purpose: 'other', purpose_detail: 'helping my uncle with roof repairs '.repeat(4) }));
    expect(long.errors?.purposeDetail).toBe('portal.send.purpose_detail_too_long');
    expect(await loadSendReview(redis, { partnerId: 'pa', phone })).toBeNull();
  });

  it('Other with a reason that names a purpose ⇒ that purpose on the review, with the words', async () => {
    await redirectOf(startSendReviewAction({}, form({ purpose: 'other', purpose_detail: 'school fees for my son' })));
    expect(await loadSendReview(redis, { partnerId: 'pa', phone })).toMatchObject({ purpose: 'education', purposeDetail: 'school fees for my son' });
  });
});

describe('setSenderNameAction', () => {
  it('stores the legal name once (set-once), audits without the value, returns to the review', async () => {
    await db.execute(sql`UPDATE customers SET full_name_enc = NULL WHERE partner_id = 'pa'`);
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Q Rivera' })))).toBe('/portal/send/review');
    const c = await createCustomerStore(db, createStore(redis, db)).getCustomer('pa', phone);
    expect(c?.fullName).toBe('Alex Q Rivera');
    const rows = await auditRows('customer.sender_name.set');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({});
    expect(JSON.stringify(rows[0])).not.toContain('Rivera');
    // Set-once: a second name never replaces it.
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Someone Else' })))).toBe('/portal/send/review');
    expect((await createCustomerStore(db, createStore(redis, db)).getCustomer('pa', phone))?.fullName).toBe('Alex Q Rivera');
    expect(await auditRows('customer.sender_name.set')).toHaveLength(1);
  });

  it('an implausible name → fixed copy; a stale session → step-up', async () => {
    expect((await setSenderNameAction({}, fd({ fullName: 'x' }))).error).toBe('portal.send.legal_name_invalid');
    h.stale = true;
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera' })))).toBe('/portal/verify?next=/portal/send/review');
  });

  it('from the Schedules pages: returns there (allow-listed), with the step-up coming back too', async () => {
    await db.execute(sql`UPDATE customers SET full_name_enc = NULL WHERE partner_id = 'pa'`);
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera', back: '/portal/schedules' })))).toBe('/portal/schedules?done=name_saved');
    expect((await createCustomerStore(db, createStore(redis, db)).getCustomer('pa', phone))?.fullName).toBe('Alex Rivera');
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera', back: '/portal/schedules/new' })))).toBe('/portal/schedules/new');
    h.stale = true;
    expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera', back: '/portal/schedules' })))).toBe('/portal/verify?next=/portal/schedules');
  });

  it('any other back value is ignored (no open redirect): the review is the target', async () => {
    await db.execute(sql`UPDATE customers SET full_name_enc = NULL WHERE partner_id = 'pa'`);
    for (const back of ['https://evil.example/x', '//evil.example', '/portal/transfers', '/portal/schedules?x=1', 'constructor', '__proto__', 'toString']) {
      expect(await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera', back })))).toBe('/portal/send/review');
    }
  });

  it('the name is the HOST tenant\'s only (B\'s row untouched)', async () => {
    await db.execute(sql`UPDATE customers SET full_name_enc = NULL`);
    await redirectOf(setSenderNameAction({}, fd({ fullName: 'Alex Rivera' })));
    const cs = createCustomerStore(db, createStore(redis, db));
    expect((await cs.getCustomer('pa', phone))?.fullName).toBe('Alex Rivera');
    expect((await cs.getCustomer('pb', phone))?.fullName ?? null).toBeNull();
  });
});

describe('sendAgainAction (Task 9.4)', () => {
  it('B\'s transfer on A\'s host → not found (404-never-403), nothing drafted', async () => {
    const r = await sendAgainAction(B.transferIds[0], { requestKey: '' }, fd());
    expect(r.error).toBe('portal.send.not_found');
    expect(drafts()).toHaveLength(0);
  });

  it('required purpose: none (or unknown) chosen ⇒ the form error, nothing drafted', async () => {
    for (const f of [fd(), fd({ purpose: '' }), fd({ purpose: 'P1301' })]) {
      const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, f);
      expect(r.error).toBe('portal.send.purpose_invalid');
    }
    expect(drafts()).toHaveLength(0);
  });

  it('own transfer → a web draft, redirect to payUrlFor(draftId); the bot pointer untouched; audited', async () => {
    const url = await redirectOf(sendAgainAction(A.transferIds[0], { requestKey: '' }, fd({ purpose: 'gift' })));
    expect(drafts()).toHaveLength(1);
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(url).toBe(payUrlFor(draftId));
    const ds = createDraftStore(redis);
    expect(await ds.getActiveDraftId('pa', phone)).toBeNull();
    expect(await ds.getActiveDraftId('pa', phone, 'web')).toBe(draftId);
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'customer.send.draft'), eq(auditEvents.partnerId, 'pa')));
    expect(rows.map((r) => r.meta)).toEqual([{ draftId, via: 'send_again' }]);
    // the purpose the customer confirmed for THIS send rides the draft
    expect((await ds.getDraft(draftId))?.purpose).toBe('gift');
  });

  it('A3: Other with no or a nonsense reason ⇒ the reason error with the choice kept; nothing drafted', async () => {
    for (const purpose_detail of ['', 'send money']) {
      const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd({ purpose: 'other', purpose_detail }));
      expect(r.error).toBe('portal.send.purpose_detail_invalid');
      expect(r.values).toEqual({ purpose: 'other', purpose_detail });
      expect(r.scamWarning).toBeUndefined();
    }
    expect(drafts()).toHaveLength(0);
  });

  it('A3: a reason that names a purpose ⇒ that purpose on the draft, with the words', async () => {
    await redirectOf(sendAgainAction(A.transferIds[0], { requestKey: '' }, fd({ purpose: 'other', purpose_detail: 'school fees for my son' })));
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(await createDraftStore(redis).getDraft(draftId)).toMatchObject({ purpose: 'education', purposeDetail: 'school fees for my son' });
  });

  it('A4: a scam-pattern reason ⇒ the warning and the tick first (no rule named), then the draft with the reason', async () => {
    const f = { purpose: 'other', purpose_detail: 'customs charge for a parcel' };
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd(f));
    expect(r).toMatchObject({ error: 'portal.send.scam_ack_required', scamWarning: true, values: f });
    expect(JSON.stringify(r)).not.toMatch(/delivery|category/);
    expect(drafts()).toHaveLength(0);
    await redirectOf(sendAgainAction(A.transferIds[0], { requestKey: '' }, fd({ ...f, scam_ack: 'on' })));
    const draftId = drafts()[0].slice('recipient_draft:'.length);
    expect(await createDraftStore(redis).getDraft(draftId)).toMatchObject({ purpose: 'other', purposeDetail: 'customs charge for a parcel' });
  });

  it('a business bill payment is never repeated as a consumer send → not found', async () => {
    await db.execute(sql`UPDATE transfers SET transfer_type = 'b2b' WHERE id = ${A.transferIds[0]}`);
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd());
    expect(r.error).toBe('portal.send.not_found');
    expect(drafts()).toHaveLength(0);
  });

  it('a blocked transfer is never repeated, even by a forged POST (the button is hidden too) → not found', async () => {
    await db.execute(sql`UPDATE transfers SET status = 'blocked' WHERE id = ${A.transferIds[0]}`);
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd());
    expect(r.error).toBe('portal.send.not_found');
    expect(drafts()).toHaveLength(0);
  });

  it('EDD → the WhatsApp copy, nothing drafted', async () => {
    await raiseDaily();
    await seedLedgerSpend(db, { partnerId: 'pa', phone, amountUsd: 2950, status: 'paid' });
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd({ purpose: 'gift' }));
    expect(r.error).toBe('portal.send.edd_whatsapp');
    expect(drafts()).toHaveLength(0);
  });

  it('stale → step-up back to the transfer; gated → verify card with no provider inquiry', async () => {
    h.stale = true;
    expect(await redirectOf(sendAgainAction(A.transferIds[0], { requestKey: '' }, fd()))).toBe(`/portal/verify?next=/portal/transfers/${A.transferIds[0]}`);
    h.stale = false;
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    const r = await sendAgainAction(A.transferIds[0], { requestKey: '' }, fd());
    expect(r.kyc).toBe('verify');
    expect(startSpy).not.toHaveBeenCalled();
    expect(drafts()).toHaveLength(0);
  });
});
