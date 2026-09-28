import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { prepareSendDraft, getQuoteTyped, type PrepareSendInput } from '@/lib/send-seam';
import { executeTool, type ToolContext } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests, FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';
import { T0_DAILY_CAP_CENTS } from '@/lib/tier-rules';
import type { Db } from '@/db/client';
import type { Customer, PartnerId } from '@/lib/types';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// UI redesign M2-4, Task 4.2: the TYPED send seam. prepareSendDraft is the body
// of send_approve_picker up to (not including) the WhatsApp card send; every
// early return is one closed arm. getQuoteTyped is the body of get_quote. The
// bot's own output through these is pinned by tests/send-seam-golden.test.ts.

const PHONE = '15551234567';
const MOM = '919876543210';
const T0_CAP_USD = T0_DAILY_CAP_CENTS / 100;

let db: Db;
let graphCalls = 0;

function stubFetch(opts: { fxDown?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('graph.facebook.com')) {
        graphCalls++;
        return { ok: true, text: async () => '', json: async () => ({}) };
      }
      if (opts.fxDown) throw new Error('net');
      return { ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) };
    }),
  );
}

async function buildCtx(
  redis: FakeRedis,
  opts: { partnerId?: PartnerId; customer?: Partial<Customer>; noName?: boolean } = {},
): Promise<ToolContext> {
  const partnerId = opts.partnerId ?? 'default';
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US', partnerId, optInAt: nowIso,
    ...(opts.noName ? {} : { fullName: 'Alex Rivera' }), createdAt: nowIso, updatedAt: nowIso, ...opts.customer,
  } as Customer);
  return {
    phone: PHONE, partnerId, store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis),
    turn: { isNewConversation: false }, customerStore,
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db),
  };
}

const input = (over: Partial<PrepareSendInput> = {}): PrepareSendInput => ({
  recipientPhone: MOM, recipientName: 'Mom', amountSource: 200, fundingMethod: 'bank_transfer', destinationCountry: 'IN', ...over,
});

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  graphCalls = 0;
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareSendDraft — typed arms', () => {
  it('happy path → draft arm; bot pointer on WhatsApp; NO WhatsApp send (the channel tail is the caller\'s)', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const r = await prepareSendDraft(ctx, input());
    expect(r.kind).toBe('draft');
    if (r.kind !== 'draft') return;
    expect(r.payUrl).toBe(`https://smartremit.test/pay/${r.draftId}`);
    expect(r.summary).toContain('Sending $200.00 to Mom.');
    expect(r.quote.amountSource).toBe(200);
    expect(r.recipientPhone).toBe(MOM);
    expect(r.destinationCountry).toBe('IN');
    expect(redis.dump.get(`active_draft:default:${PHONE}`)).toBe(r.draftId);
    expect(graphCalls).toBe(0);
    const draft = await ctx.draftStore.getDraft(r.draftId);
    expect(draft?.partnerId).toBe('default');
    expect(draft).not.toHaveProperty('channel');
  });

  it('web channel ctx → the web pointer by default (the bot pointer is never touched)', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const r = await prepareSendDraft({ ...ctx, channel: 'web' }, input());
    if (r.kind !== 'draft') throw new Error(r.kind);
    expect(redis.dump.has(`active_draft:default:${PHONE}`)).toBe(false);
    expect(redis.dump.get(`active_draft:web:default:${PHONE}`)).toBe(r.draftId);
    expect((await ctx.draftStore.getDraft(r.draftId))?.channel).toBe('web');
  });

  it("an explicit { pointer: 'web' } uses the web pointer", async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const r = await prepareSendDraft(ctx, input(), { pointer: 'web' });
    if (r.kind !== 'draft') throw new Error(r.kind);
    expect(redis.dump.get(`active_draft:web:default:${PHONE}`)).toBe(r.draftId);
    expect(redis.dump.has(`active_draft:default:${PHONE}`)).toBe(false);
  });

  it('invalid phone / bad funding / missing or unknown destination', async () => {
    const ctx = await buildCtx(fakeRedis());
    expect(await prepareSendDraft(ctx, input({ recipientPhone: '12' }))).toEqual({ kind: 'invalid_phone' });
    expect((await prepareSendDraft(ctx, input({ fundingMethod: 'crypto' }))).kind).toBe('bad_funding');
    expect((await prepareSendDraft(ctx, input({ destinationCountry: undefined, recipientPhone: '525512345678' }))).kind).toBe('missing_destination');
    expect((await prepareSendDraft(ctx, input({ destinationCountry: 'ZZ' }))).kind).toBe('invalid_request');
    expect((await prepareSendDraft(ctx, input({ amountSource: 0.5 }))).kind).toBe('invalid_request');
  });

  it('KYC gate on + unverified → kyc_required with the url', async () => {
    const redis = fakeRedis();
    const dflt = await buildCtx(redis);
    const nowIso = new Date().toISOString();
    await dflt.partnerStore.savePartner({
      id: 'gated', name: 'gated', countries: ['US'], status: 'active', kycMode: 'ours',
      requireKycBeforeSend: true, createdAt: nowIso, updatedAt: nowIso,
    });
    const ctx = await buildCtx(redis, { partnerId: 'gated', customer: { kycStatus: 'not_started' } });
    expect(await prepareSendDraft(ctx, input())).toEqual({ kind: 'kyc_required', kycUrl: 'https://example.com/admin-dashboard/customers' });
  });

  it('no sender name → sender_name_required', async () => {
    const ctx = await buildCtx(fakeRedis(), { noName: true });
    expect(await prepareSendDraft(ctx, input())).toEqual({ kind: 'sender_name_required' });
  });

  it('over the per-transfer cap → cap arm with the evaluation', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await prepareSendDraft(ctx, input({ amountSource: T0_CAP_USD + 200 }));
    expect(r.kind).toBe('cap');
    if (r.kind === 'cap') expect(r.evaluation.reason).toBe('over_per_transfer_cap');
  });

  it('sanctions hit → { kind: "blocked" } with NO reason, plus the blocked row and its sanctions.screen evidence', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const r = await prepareSendDraft(ctx, input({ recipientName: 'John Doe' }));
    expect(r).toEqual({ kind: 'blocked' });
    const blocked = (await ctx.store.listTransfers()).filter((t) => t.status === 'blocked');
    expect(blocked).toHaveLength(1);
    const ev = (await db.execute(
      sql`SELECT subject_id FROM audit_events WHERE action = 'sanctions.screen'`,
    )) as unknown as { rows: Array<{ subject_id: string }> };
    expect(ev.rows).toEqual([{ subject_id: blocked[0].id }]);
    expect([...redis.dump.keys()].filter((k) => k.startsWith('recipient_draft:'))).toEqual([]);
  });

  it('FX down → fx_unavailable', async () => {
    const ctx = await buildCtx(fakeRedis());
    resetRateCacheForTests();
    stubFetch({ fxDown: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await prepareSendDraft(ctx, input())).toEqual({ kind: 'fx_unavailable', message: FX_UNAVAILABLE_MESSAGE });
  });

  it('a B2B shape without the sender\'s own open bill → bill_refused, no draft', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const r = await prepareSendDraft(ctx, input({ fundingMethod: 'ach_pull', amountSource: 400 }));
    expect(r.kind).toBe('bill_refused');
    expect([...redis.dump.keys()]).toEqual([]);
  });

  it('tenant isolation: pa and pb with the same phone get their own drafts and pointers', async () => {
    const redis = fakeRedis();
    await seedPartner(db, 'pa', 'Partner A');
    await seedPartner(db, 'pb', 'Partner B');
    const pa = await buildCtx(redis, { partnerId: 'pa' });
    const pb = await buildCtx(redis, { partnerId: 'pb' });
    const a = await prepareSendDraft(pa, input());
    const b = await prepareSendDraft(pb, input({ amountSource: 120 }));
    if (a.kind !== 'draft' || b.kind !== 'draft') throw new Error('expected drafts');
    expect((await pa.draftStore.getDraft(a.draftId))?.partnerId).toBe('pa');
    expect((await pb.draftStore.getDraft(b.draftId))?.partnerId).toBe('pb');
    expect(redis.dump.get(`active_draft:pa:${PHONE}`)).toBe(a.draftId);
    expect(redis.dump.get(`active_draft:pb:${PHONE}`)).toBe(b.draftId);
  });

  it('the intended bot-visible change: a web-chat repeat_transfer draft sits under the WEB pointer, so a WhatsApp cancel cannot consume it', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    await seedLedgerSpend(db, {
      partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered', id: 'past_seam_1',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const r = await executeTool('repeat_transfer', { transfer_id: 'past_seam_1' }, { ...ctx, channel: 'web' });
    expect(typeof r.draft_id).toBe('string');
    expect(redis.dump.get(`active_draft:web:default:${PHONE}`)).toBe(r.draft_id);
    expect(redis.dump.has(`active_draft:default:${PHONE}`)).toBe(false);
    const cancel = await executeTool('cancel_draft', {}, ctx);
    expect(cancel.cancelled).toBe(false);
    expect(await ctx.draftStore.getDraft(r.draft_id as string)).not.toBeNull();
  });

  it('the input type has no payout fields (payout_* is server-only)', () => {
    // @ts-expect-error — a caller cannot pass a payout destination.
    const bad: PrepareSendInput = { ...input(), payoutDestination: '1234' };
    expect(bad).toBeDefined();
  });
});

describe('getQuoteTyped — typed arms', () => {
  it('happy → quote arm', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await getQuoteTyped(ctx, { amountSource: 200, fundingMethod: 'bank_transfer' });
    expect(r.kind).toBe('quote');
    if (r.kind === 'quote') {
      expect(r.quote.amountSource).toBe(200);
      expect(r.destinationCountry).toBe('IN');
    }
  });

  it('over cap → cap arm; FX down → fx_unavailable; bad amount → invalid_request', async () => {
    const ctx = await buildCtx(fakeRedis());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cap = await getQuoteTyped(ctx, { amountSource: T0_CAP_USD + 200 });
    expect(cap.kind).toBe('cap');
    if (cap.kind === 'cap') expect(cap.kycUrl).toBeUndefined();
    expect((await getQuoteTyped(ctx, { amountSource: 'abc' })).kind).toBe('invalid_request');
    resetRateCacheForTests();
    stubFetch({ fxDown: true });
    expect(await getQuoteTyped(ctx, { amountSource: 200 })).toEqual({ kind: 'fx_unavailable', message: FX_UNAVAILABLE_MESSAGE });
  });
});
