import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { prepareSendDraft, type PrepareSendInput } from '@/lib/send-seam';
import { buildApproveSummary, executeTool, type ToolContext } from '@/lib/tools';
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
import type { B2bInvoice, CurrencyCode, Customer, PartnerId, Quote, TurnContext } from '@/lib/types';
import { RISK_WARNING_TEXT } from '@/lib/legal/risk-warning';
import { PROVIDER_LINE_MAX } from '@/lib/legal/provider-line';
import { PURPOSE_SCAM_WARNING } from '@/lib/purpose-detail';
import { NAME_MAX } from '@/lib/untrusted-text';
import { FESTIVAL_NAME_MAX } from '@/lib/rewards/settings';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner, seedPriorSends } from './helpers-db';
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

// Fix pack 6 (R48, P19 T26b): when the draft carries risk signals, the ONE
// fixed warning (RISK_WARNING_TEXT) heads the WhatsApp Approve card and the
// tool result carries risk_warning for the agent's composeReply slot; the
// scam warning wins (never both); no signals -> today's bytes.
describe('the chat risk warning: card prefix and tool fields (pack 6 P19 T26b)', () => {
  const TAP = '\n\nTap to pay securely, or reply cancel to stop.';
  const stubWhatsApp = () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).includes('graph.facebook.com')) bodies.push(String(init?.body ?? ''));
      return { ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) };
    }));
    return bodies;
  };
  const cardText = (body: string) => String((JSON.parse(body) as { interactive?: { body?: { text?: string } } }).interactive?.body?.text ?? '');
  const picker = (over: Record<string, unknown> = {}) => ({
    amount_source: 600, recipient_name: 'Mom', recipient_phone: MOM, destination_country: 'IN', funding_method: 'bank_transfer', ...over,
  });

  it('signals on the draft -> the card body starts with RISK_WARNING_TEXT + blank line; the tool returns risk_warning: RISK_WARNING_TEXT', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    const bodies = stubWhatsApp();
    const r = await executeTool('send_approve_picker', picker(), ctx);
    expect(r.sent).toBe(true);
    expect(r.risk_warning).toBe(RISK_WARNING_TEXT);
    expect(r).not.toHaveProperty('scam_warning');
    expect(Object.keys(r)).toEqual(['sent', 'draft_id', 'risk_warning']);
    expect(bodies).toHaveLength(1);
    const text = cardText(bodies[0]);
    expect(text.startsWith(`${RISK_WARNING_TEXT}\n\nSending `)).toBe(true);
    expect(text.endsWith(TAP)).toBe(true);
    expect(text.split(RISK_WARNING_TEXT)).toHaveLength(2);
    // The result carries the constant only: never a signal name.
    expect(JSON.stringify(r)).not.toMatch(/first_to_recipient|first_transfer|amount_over_threshold|new_account|chat_cue/);
  });

  it('no signals -> no risk_warning key; card bytes as today (the same card as with the config off)', async () => {
    await acmeOn();
    await seedPriorSends(db, 'acme', PHONE, { paid: 1, toRecipient: 1, recipientPhone: MOM });
    const on = await buildCtx();
    const bodiesOn = stubWhatsApp();
    const rOn = await executeTool('send_approve_picker', picker({ amount_source: 200 }), on);
    expect(rOn).not.toHaveProperty('risk_warning');
    expect(Object.keys(rOn)).toEqual(['sent', 'draft_id']);

    await setRisk('acme', riskConfigFor({ enabled: false }));
    const off = await buildCtx();
    const bodiesOff = stubWhatsApp();
    const rOff = await executeTool('send_approve_picker', picker({ amount_source: 200 }), off);
    expect(Object.keys(rOff)).toEqual(['sent', 'draft_id']);
    expect(cardText(bodiesOn[0])).toBe(cardText(bodiesOff[0]));
    expect(cardText(bodiesOn[0]).startsWith('Sending ')).toBe(true);
    expect(cardText(bodiesOn[0])).not.toContain(RISK_WARNING_TEXT);
  });

  it('scam wins: a scam-pattern purpose with signals -> scam_warning only, no risk_warning key; the card starts with PURPOSE_SCAM_WARNING', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    const bodies = stubWhatsApp();
    const r = await executeTool('send_approve_picker', picker({ purpose: 'other', purpose_detail: 'to claim my lottery prize' }), ctx);
    expect(r.sent).toBe(true);
    expect(r.scam_warning).toBe(PURPOSE_SCAM_WARNING);
    expect(r).not.toHaveProperty('risk_warning');
    const d = await ctx.draftStore.getDraft(String(r.draft_id));
    expect(d?.riskSignals?.length).toBeGreaterThan(0); // the signals are still on the draft
    const text = cardText(bodies[0]);
    expect(text.startsWith(`${PURPOSE_SCAM_WARNING}\n\nSending `)).toBe(true);
    expect(text).not.toContain(RISK_WARNING_TEXT);
  });

  it("web channel: the result has risk_warning and the reply_hint starts with 'start your reply with the risk_warning text word for word, then '", async () => {
    await acmeOn();
    const ctx = await buildCtx();
    stubWhatsApp();
    // An unpaid past row to Mom: not a prior send, so the repeat still raises signals.
    const pastId = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 600, recipientPhone: MOM });
    const web = { ...ctx, channel: 'web' as const };
    const r = await executeTool('repeat_transfer', { transfer_id: pastId, amount_source: 600 }, web);
    expect(typeof r.pay_url).toBe('string');
    expect(r.risk_warning).toBe(RISK_WARNING_TEXT);
    expect(r).not.toHaveProperty('scam_warning');
    expect(String(r.reply_hint).startsWith('start your reply with the risk_warning text word for word, then show the summary')).toBe(true);
    expect(Object.keys(r)).toEqual(['draft_id', 'summary', 'pay_url', 'risk_warning', 'reply_hint']);
  });

  it('web channel, scam wins: scam_warning and the scam hint only', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    stubWhatsApp();
    const pastId = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 600, recipientPhone: MOM });
    const web = { ...ctx, channel: 'web' as const };
    const r = await executeTool('repeat_transfer', { transfer_id: pastId, amount_source: 600, purpose: 'other', purpose_detail: 'customs charge for a parcel' }, web);
    expect(r.scam_warning).toBe(PURPOSE_SCAM_WARNING);
    expect(r).not.toHaveProperty('risk_warning');
    expect(String(r.reply_hint)).toMatch(/^start your reply with the scam_warning text word for word, then show the summary/);
  });

  it('web channel, no signals: no risk_warning key and the hint as today', async () => {
    await seedPartner(db, 'acme');
    const ctx = await buildCtx();
    stubWhatsApp();
    const pastId = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 600, recipientPhone: MOM });
    const r = await executeTool('repeat_transfer', { transfer_id: pastId, amount_source: 600 }, { ...ctx, channel: 'web' as const });
    expect(Object.keys(r)).toEqual(['draft_id', 'summary', 'pay_url', 'reply_hint']);
    expect(String(r.reply_hint).startsWith('show the summary')).toBe(true);
  });

  it('the duplicate-card return is unchanged', async () => {
    await acmeOn();
    const ctx = await buildCtx();
    const bodies = stubWhatsApp();
    const first = await executeTool('send_approve_picker', picker(), ctx);
    expect(first.risk_warning).toBe(RISK_WARNING_TEXT);
    const dup = await executeTool('send_approve_picker', picker(), ctx);
    expect(dup).toEqual({
      sent: false,
      duplicate: true,
      draft_id: dup.draft_id,
      reply_hint: 'The payment card for this exact send is already above — ask the customer to tap it, or say what to change.',
    });
    expect(Object.keys(dup)).toEqual(['sent', 'duplicate', 'draft_id', 'reply_hint']);
    expect(bodies).toHaveLength(1);
  });

  it("card body length: each warning + blank line + the longest summary + the tap line <= 1024 (WhatsApp's interactive body limit)", () => {
    const currencies: CurrencyCode[] = ['USD', 'CAD', 'GBP', 'AED', 'SGD', 'AUD', 'NZD', 'INR', 'HKD', 'MXN', 'EUR'];
    const today = new Date().toISOString().slice(0, 10);
    let longest = '';
    for (const destinationCurrency of currencies) {
      for (const sourceCurrency of currencies) {
        const q: Quote = {
          amountUsd: 99_999.99, feeUsd: 9_999.99, totalChargeUsd: 109_999.98, fxRate: 99_999.99, amountInr: 9_999_999_999.99,
          deliveryEstimate: 'within 1 business day', sourceCurrency, amountSource: 99_999.99, feeSource: 9_999.99,
          totalChargeSource: 109_999.98, destinationCurrency,
        };
        const summary = buildApproveSummary(
          q, 'N'.repeat(NAME_MAX), 'bank', 'AE070331234567890123456', 'credit_card', destinationCurrency, 30, today,
          { kind: 'festival', discountUsd: 9_999.99, detail: { festivalName: 'F'.repeat(FESTIVAL_NAME_MAX) } },
          'P'.repeat(PROVIDER_LINE_MAX),
        );
        if (summary.length > longest.length) longest = summary;
      }
    }
    expect(longest).toContain('N'.repeat(NAME_MAX));
    expect(longest).toContain('daily reference rate');
    expect(longest).toContain('F'.repeat(FESTIVAL_NAME_MAX));
    expect(longest).toContain('P'.repeat(PROVIDER_LINE_MAX));
    for (const warning of [RISK_WARNING_TEXT, PURPOSE_SCAM_WARNING]) {
      expect(`${warning}\n\n${longest}${TAP}`.length).toBeLessThanOrEqual(1024);
    }
  });
});
