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

// UI redesign M2-9, Task 9.2: the Send and Review PAGES (GET). No provider writes on GET: a gated or
// T0 customer's renders never start a verification inquiry; the price is always re-quoted.
// (Harness shared with tests/portal-send-actions.test.ts.)
// Below: the original actions-harness header.
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

import { renderToStaticMarkup } from 'react-dom/server';
import SendPage from '@/app/portal/send/page';
import ReviewPage from '@/app/portal/send/review/page';
import TransferDetailPage from '@/app/portal/transfers/[id]/page';
import { continueToPayAction } from '@/app/portal/send/actions';

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
  purpose: 'medical',
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

const sendHtml = async (q: Record<string, string> = {}) => renderToStaticMarkup(await SendPage({ searchParams: Promise.resolve(q) }));
const reviewHtml = async () => renderToStaticMarkup(await ReviewPage());

describe('the Send page (GET)', () => {
  it('apex → 404', async () => {
    h.site = null;
    await expect(SendPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    await expect(ReviewPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('H2: a valid amount/to pre-fills; the saved recipient list shows masked accounts only', async () => {
    const html = await sendHtml({ amount: '250', to: 'MX' });
    expect(html).toContain('value="250.00"');
    expect(html).toMatch(/<option value="MX" selected/);
    expect(html).toContain('Recipient PA');
    expect(html).not.toContain(A.recipientPhones[0]);
    expect(html).not.toContain('000011112222');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('required purpose: a "Why you are sending" select with the 8 reasons and no reason chosen up front', async () => {
    const html = await sendHtml();
    expect(html).toContain('Why you are sending');
    expect(html).toMatch(/<select[^>]*name="purpose"[^>]*required/);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a reason<\/option>/);
    for (const [value, label] of [['family_support', 'Family support'], ['gift', 'Gift'], ['education', 'Education'], ['medical', 'Medical'], ['savings', 'Savings'], ['bills', 'Bills'], ['business', 'Business'], ['other', 'Other']]) {
      expect(html).toContain(`<option value="${value}">${label}</option>`);
    }
    // after the recipient choice
    expect(html.indexOf('name="purpose"')).toBeGreaterThan(html.indexOf('name="recipient"'));
  });

  it('H2: doubtful values are dropped silently (never echoed)', async () => {
    const html = await sendHtml({ amount: '<b>9</b>', to: 'ZZ' });
    expect(html).not.toContain('&lt;b&gt;');
    expect(html).not.toContain('ZZ');
    expect(html).toContain('name="amount"');
    const over = await sendHtml({ amount: '999999' });
    expect(over).not.toContain('999999');
  });

  it("?r=: A's own rid pre-selects; B's rid (or a deleted one) is dropped", async () => {
    const ridA = recipientRid('pa', phone, A.recipientPhones[0]);
    const own = await sendHtml({ r: ridA });
    expect(own).toMatch(new RegExp(`checked="" value="${ridA}"`));
    const ridB = recipientRid('pb', phone, B.recipientPhones[0]);
    const html = await sendHtml({ r: ridB });
    expect(html).not.toContain(ridB);
  });

  it('a gated customer sees the verify card (Profile link) and no form; no provider inquiry', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    const html = await sendHtml();
    expect(html).toContain('data-kyc-card="verify"');
    expect(html).toContain('href="/portal/profile#verify"');
    expect(html).not.toContain('name="amount"');
    expect(startSpy.mock.calls).toHaveLength(0);
  });

  it('M2-14 (#413 L1): a grandfathered customer on a gate-on partner gets the contact card, not a dead-end verify link', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'grandfathered' });
    const html = await sendHtml();
    expect(html).toContain('data-kyc-card="contact"');
    expect(html).not.toContain('/portal/profile#verify');
  });

  it('M2-14: a customer IN REVIEW keeps the verify card (Profile shows "In review"; nothing to contact the partner about)', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    await db.execute(sql`UPDATE customers SET kyc_review_state = 'pending_review' WHERE partner_id = 'pa' AND phone = ${phone}`);
    const html = await sendHtml();
    expect(html).toContain('data-kyc-card="verify"');
  });

  it('M2-14 (#413 L1): on a DELEGATED partner (the partner verifies) a gated customer gets the contact card', async () => {
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated', require_kyc_before_send = true WHERE id = 'pa'`);
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'not_started' });
    const html = await sendHtml();
    expect(html).toContain('data-kyc-card="contact"');
    expect(html).not.toContain('/portal/profile#verify');
  });

  it('a rejected customer is told to contact the partner: no verify link, no retry', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'rejected' });
    const html = await sendHtml();
    expect(html).toContain('data-kyc-card="contact"');
    expect(html).toContain('Brand pa');
    expect(html).not.toContain('/portal/profile');
  });
});

describe('the Review page (GET)', () => {
  it('nothing in progress → the empty state with a link to start', async () => {
    const html = await reviewHtml();
    expect(html).toContain('data-empty');
    expect(html).toContain('href="/portal/send"');
  });

  it('a gated customer: 3 renders → the verify card, NO provider inquiry, no Continue', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    await review('pa');
    for (let i = 0; i < 3; i++) {
      const html = await reviewHtml();
      expect(html).toContain('data-kyc-card="verify"');
      expect(html).not.toContain('name="rv"');
    }
    expect(startSpy.mock.calls).toHaveLength(0);
  });

  it('a VERIFIED customer inside the 3-day window (gate on): 3 renders start NO inquiry and show Continue', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone, firstSeenDaysAgo: 1, kycStatus: 'verified' });
    await review('pa');
    for (let i = 0; i < 3; i++) expect(await reviewHtml()).toContain('name="rv"');
    expect(startSpy.mock.calls).toHaveLength(0);
  });

  it('happy path: the re-quoted price, the recipient masked, the review id + request key only', async () => {
    const rv = await review('pa');
    const html = await reviewHtml();
    expect(html).toContain(`value="${rv}"`);
    expect(html).toContain('Mom');
    expect(html).toContain('•••• 3210');
    expect(html).not.toContain(MOM);
    expect(html).toContain('$200.00');
    expect(html).toMatch(/1 USD = 85 INR/);
    expect(html).not.toMatch(/name="(amount|rate|fee|fxRate)"/);
    expect(prepareSpy).not.toHaveBeenCalled();
    // Required purpose: the review shows the chosen reason in plain words (no code)
    expect(html).toContain('Why you are sending');
    expect(html).toContain('Medical');
    expect(html).not.toContain('medical<');
  });

  it('EDD → the WhatsApp copy and no Continue', async () => {
    await raiseDaily();
    await seedLedgerSpend(db, { partnerId: 'pa', phone, amountUsd: 2850, status: 'paid' });
    await review('pa');
    const html = await reviewHtml();
    expect(html).toContain('WhatsApp');
    expect(html).not.toContain('name="rv"');
  });

  it('no legal name on file → the name step first (no quote shown)', async () => {
    await db.execute(sql`UPDATE customers SET full_name_enc = NULL WHERE partner_id = 'pa'`);
    await review('pa');
    const html = await reviewHtml();
    expect(html).toContain('name="fullName"');
    expect(html).not.toContain('name="rv"');
  });

  it('a saved recipient deleted since → "not found", no Continue', async () => {
    const rid = recipientRid('pa', phone, A.recipientPhones[0]);
    await review('pa', { ...newRecipient, recipient: { kind: 'saved', rid } });
    await deleteRecipientWithSchedules(db, 'pa', phone, rid);
    const html = await reviewHtml();
    expect(html).toContain('We could not find that recipient');
    expect(html).not.toContain('name="rv"');
  });

  it('M1: back on review after the draft was used or expired → "already sent", NO Continue (no duplicate send)', async () => {
    const rv = await review('pa');
    await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    for (const k of drafts()) await redis.del(k); // paid (consumed) or expired: the same from here
    const html = await reviewHtml();
    expect(html).toContain('data-already-sent');
    expect(html).toContain('href="/portal/transfers"');
    expect(html).not.toContain('name="rv"');
  });

  it('M1: back on review while the draft is still live → a link to that same payment page, NO Continue', async () => {
    const rv = await review('pa');
    const url = await redirectOf(continueToPayAction({ requestKey: '' }, fd({ rv })));
    const html = await reviewHtml();
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain('name="rv"');
  });
});

describe('the transfer detail', () => {
  it('shows Send again for an own transfer', async () => {
    const html = renderToStaticMarkup(await TransferDetailPage({ params: Promise.resolve({ id: A.transferIds[0] }) }));
    expect(html).toContain('data-send-again');
  });

  it('required purpose (Q1): Send again offers the last purpose as the visible default; none ⇒ "Choose a reason"', async () => {
    const none = renderToStaticMarkup(await TransferDetailPage({ params: Promise.resolve({ id: A.transferIds[0] }) }));
    expect(none).toMatch(/<select[^>]*name="purpose"/);
    expect(none).toMatch(/<option value="" disabled="" selected="">Choose a reason<\/option>/);
    await db.execute(sql`UPDATE transfers SET purpose = 'medical' WHERE id = ${A.transferIds[0]}`);
    const withLast = renderToStaticMarkup(await TransferDetailPage({ params: Promise.resolve({ id: A.transferIds[0] }) }));
    expect(withLast).toMatch(/<option value="medical" selected="">Medical<\/option>/);
  });
});
