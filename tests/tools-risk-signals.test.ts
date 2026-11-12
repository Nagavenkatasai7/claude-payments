import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { prepareSendDraft, type PrepareSendInput } from '@/lib/send-seam';
import type { ToolContext } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { RISK_CHAT_CUES } from '@/lib/risk-chat-cue';
import type { B2bInvoice, Customer, PartnerId, TurnContext } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedPriorSends } from './helpers-db';
import { riskConfigFor } from './helpers-risk';

// Fix pack 6 (R48, P19 T26a): the draft that becomes the pay link records the
// risk signals the customer is warned about, from the SAME inputs as the mint
// (T25): the mint's corridor (sourceCountryFor), store.priorSends (paid or
// delivered), the one firstSeenAt rule (store.firstSeenAt), the quoted USD
// amount and the turn's in-memory chat cue. Off (the default; always for the
// default tenant, 'test' and b2b): no read, no draft key, no result key.

const logs = vi.hoisted(() => ({ warns: [] as Array<{ scope: string; msg: unknown; fields?: Record<string, unknown> }> }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (scope: string, msg: unknown, fields?: Record<string, unknown>) => {
      logs.warns.push({ scope, msg, fields });
    },
  };
});

const PHONE = '15551234567';
const MOM = '919876543210';
const DAY = 86_400_000;

let db: Db;

beforeEach(async () => {
  logs.warns.length = 0;
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Write the US corridor's riskSignals entry (the stored shape, P22). */
async function setRisk(partnerId: string, cfg: unknown) {
  await db.execute(sql`
    UPDATE partners SET corridor_compliance = jsonb_set(
      coalesce(corridor_compliance, '{}'::jsonb), '{US}',
      coalesce(corridor_compliance->'US', '{}'::jsonb) || jsonb_build_object('riskSignals', ${JSON.stringify(cfg)}::jsonb)
    ) WHERE id = ${partnerId}`);
}

/** A verified named sender; seasoned (10 days, T1) unless firstSeenAt says otherwise. */
async function buildCtx(
  o: { partnerId?: PartnerId; customer?: Partial<Customer>; turn?: TurnContext } = {},
): Promise<ToolContext> {
  const partnerId = o.partnerId ?? 'acme';
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: new Date(Date.now() - 10 * DAY).toISOString(), kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, fullName: 'Alex Rivera', createdAt: nowIso, updatedAt: nowIso,
    ...o.customer,
  } as Customer);
  return {
    phone: PHONE, partnerId, store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis),
    turn: o.turn ?? { isNewConversation: false }, customerStore,
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db),
  };
}

const input = (over: Partial<PrepareSendInput> = {}): PrepareSendInput => ({
  recipientPhone: MOM, recipientName: 'Mom', amountSource: 600, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
  destinationCountry: 'IN', ...over,
});

async function acmeOn(cfg: unknown = riskConfigFor()) {
  await seedPartner(db, 'acme');
  await setRisk('acme', cfg);
}

async function draftOf(ctx: ToolContext, over: Partial<PrepareSendInput> = {}) {
  const r = await prepareSendDraft(ctx, input(over));
  if (r.kind !== 'draft') throw new Error(`expected a draft, got ${r.kind}`);
  const draft = await ctx.draftStore.getDraft(r.draftId);
  if (!draft) throw new Error('no draft');
  return { r, draft };
}

function spyReads(ctx: ToolContext) {
  return {
    sends: vi.spyOn(ctx.store, 'priorSends'),
    seen: vi.spyOn(ctx.store, 'firstSeenAt'),
  };
}

describe('prepareSendDraft risk signals (pack 6 P19 T26a)', () => {
  it('off by default: a draft has no riskSignals key and the prepare result has no riskSignals key; store.priorSends / firstSeenAt are never called', async () => {
    await seedPartner(db, 'acme');
    const ctx = await buildCtx({ turn: { isNewConversation: false, chatRiskCue: true } });
    const reads = spyReads(ctx);
    const { r, draft } = await draftOf(ctx);
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
    expect(reads.sends).not.toHaveBeenCalled();
    expect(reads.seen).not.toHaveBeenCalled();
  });

  it('off: enabled false stored -> no key, no read', async () => {
    await acmeOn(riskConfigFor({ enabled: false }));
    const ctx = await buildCtx({ turn: { isNewConversation: false, chatRiskCue: true } });
    const reads = spyReads(ctx);
    const { r, draft } = await draftOf(ctx);
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
    expect(reads.sends).not.toHaveBeenCalled();
    expect(reads.seen).not.toHaveBeenCalled();
  });

  it('off: the default tenant with the config forced on -> no key, no read', async () => {
    await setRisk('default', riskConfigFor());
    const ctx = await buildCtx({ partnerId: 'default', turn: { isNewConversation: false, chatRiskCue: true } });
    const reads = spyReads(ctx);
    const { r, draft } = await draftOf(ctx);
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
    expect(reads.sends).not.toHaveBeenCalled();
    expect(reads.seen).not.toHaveBeenCalled();
  });

  it('off: a b2b bill draft with the config on -> no key, no read', async () => {
    await acmeOn();
    const ctx = await buildCtx({ turn: { isNewConversation: false, chatRiskCue: true } });
    const invoice = {
      id: 'inv_risk_1', partnerId: 'acme', businessName: 'Seller Co', buyerPhone: PHONE, lineItems: [],
      amountUsd: 600, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
    } as unknown as B2bInvoice;
    vi.spyOn(ctx.store, 'getB2bInvoiceScoped').mockResolvedValue(invoice);
    const reads = spyReads(ctx);
    const { r, draft } = await draftOf(ctx, {
      fundingMethod: 'ach_pull', entityType: 'business', senderBusinessName: 'Buyer LLC',
      recipientBusinessName: 'Seller Co', recipientName: 'Seller Co', invoiceId: 'inv_risk_1',
    });
    expect(draft.transferType).toBe('b2b');
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
    expect(reads.sends).not.toHaveBeenCalled();
    expect(reads.seen).not.toHaveBeenCalled();
  });

  it("on: a first send of $600 to a new recipient -> draft.riskSignals ['first_to_recipient','first_transfer','amount_over_threshold'] and the same list on the draft result", async () => {
    await acmeOn();
    const ctx = await buildCtx();
    const reads = spyReads(ctx);
    const { r, draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold']);
    expect(r.kind === 'draft' && r.riskSignals).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold']);
    expect(reads.sends).toHaveBeenCalledTimes(1);
    expect(reads.sends).toHaveBeenCalledWith('acme', PHONE, MOM);
    expect(reads.seen).toHaveBeenCalledTimes(1);
    expect(reads.seen.mock.calls[0].slice(0, 2)).toEqual(['acme', PHONE]);
  });

  it("the corridor is the mint's: partner countries ['US'], only US configured, the customer row saved with senderCountry 'GB' -> a USD send still derives signals", async () => {
    await acmeOn();
    const ctx = await buildCtx({ customer: { senderCountry: 'GB' } });
    const { draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold']);
  });

  it('prior paid send to the same recipient (seedPriorSends) -> no first_to_recipient, no first_transfer', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    const { r, draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['amount_over_threshold']);
    expect(r.kind === 'draft' && r.riskSignals).toEqual(['amount_over_threshold']);
  });

  it('prior paid send elsewhere -> first_to_recipient only (no first_transfer)', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 0, recipientPhone: MOM });
    const { draft } = await draftOf(ctx, { amountSource: 200 });
    expect(draft.riskSignals).toEqual(['first_to_recipient']);
  });

  it('nothing raised -> no key on the draft or the result (omitted when empty)', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    const { r, draft } = await draftOf(ctx, { amountSource: 200 });
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
  });

  it('new_account uses store.firstSeenAt (customers row first seen 1 hour ago -> new_account)', async () => {
    await acmeOn();
    const ctx = await buildCtx({ customer: { firstSeenAt: new Date(Date.now() - 3_600_000).toISOString() } });
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    const reads = spyReads(ctx);
    const { draft } = await draftOf(ctx, { amountSource: 200 });
    expect(draft.riskSignals).toEqual(['new_account']);
    expect(reads.seen).toHaveBeenCalledTimes(1);
  });

  it('chat cue: ctx.turn.chatRiskCue true -> chat_cue; absent -> none', async () => {
    await acmeOn();
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    const on = await buildCtx({ turn: { isNewConversation: false, chatRiskCue: true } });
    expect((await draftOf(on, { amountSource: 200 })).draft.riskSignals).toEqual(['chat_cue']);
    const off = await buildCtx();
    expect((await draftOf(off, { amountSource: 200 })).draft).not.toHaveProperty('riskSignals');
  });

  it('a failed read never blocks: store.priorSends throws -> no recipient/first signals, the draft is made', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'priorSends').mockRejectedValue(new TypeError('boom 15551234567'));
    const { r, draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['amount_over_threshold']);
    expect(r.kind === 'draft' && r.riskSignals).toEqual(['amount_over_threshold']);
    const mine = logs.warns.filter((w) => w.scope === 'draft.risk-signals');
    expect(mine).toEqual([{ scope: 'draft.risk-signals', msg: 'TypeError', fields: { partnerId: 'acme' } }]);
  });

  it('a failed read never blocks: store.firstSeenAt throws -> no new_account', async () => {
    await acmeOn();
    const ctx = await buildCtx({ customer: { firstSeenAt: new Date(Date.now() - 3_600_000).toISOString() } });
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    vi.spyOn(ctx.store, 'firstSeenAt').mockRejectedValue(new RangeError('boom'));
    const { r, draft } = await draftOf(ctx, { amountSource: 200 });
    expect(draft).not.toHaveProperty('riskSignals');
    expect(r).not.toHaveProperty('riskSignals');
    const mine = logs.warns.filter((w) => w.scope === 'draft.risk-signals');
    expect(mine).toEqual([{ scope: 'draft.risk-signals', msg: 'RangeError', fields: { partnerId: 'acme' } }]);
  });

  it('both reads fail -> one warning per failure, still a draft', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'priorSends').mockRejectedValue(new Error('x'));
    vi.spyOn(ctx.store, 'firstSeenAt').mockRejectedValue(new Error('y'));
    const { draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['amount_over_threshold']);
    expect(logs.warns.filter((w) => w.scope === 'draft.risk-signals')).toHaveLength(2);
  });

  it('a scam-pattern purpose with risk on -> draft.riskSignals still recorded', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    const { draft } = await draftOf(ctx, {
      purpose: 'family_support',
      purposeDetail: 'the customs officer said I must pay a fee to release my parcel',
    });
    expect(draft.riskSignals).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold']);
  });

  it('the draft and the result carry enum names only (JSON of the stored draft has no cue word)', async () => {
    await acmeOn();
    const ctx = await buildCtx({ turn: { isNewConversation: false, chatRiskCue: true } });
    const { r, draft } = await draftOf(ctx);
    expect(draft.riskSignals).toEqual(['first_to_recipient', 'first_transfer', 'amount_over_threshold', 'chat_cue']);
    const json = JSON.stringify(draft) + JSON.stringify(r);
    for (const cue of [...RISK_CHAT_CUES.en, ...RISK_CHAT_CUES.hinglish, ...RISK_CHAT_CUES.devanagari]) {
      expect(json.toLowerCase()).not.toContain(cue);
    }
    expect(json).not.toContain('chatRiskCue');
  });
});
