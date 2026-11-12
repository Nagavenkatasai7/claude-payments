// Fix pack 8 (R44, P11, T13): the bot tools open or point to the case.
// open_recall_dispute routes every report through routeReport (P5): a consumer transfer opens (or
// reuses) its regulatory case and returns the case reference, the due date and the fixed reply of
// P10; inside the cancel window the cancel is ALSO offered (DP13); a b2b or sandbox transfer keeps
// today's 24-hour recall case. No step-up, support_off or open-ticket cap refuses a classed case (DP9).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { cancelWithinWindow } from '@/lib/sender-cancel';
import { resetRateCacheForTests } from '@/lib/rate';
import { CANCEL_REPLY_HINT } from '@/lib/legal/cancel-drafts';
import { caseOpenedReply } from '@/lib/legal/error-notice-drafts';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { mintViaPayPage } from './helpers-mint';

const PHONE = '15551234567';
const DAY = 86_400_000;
let db: Db;

async function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE, partnerId = 'default') {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, fullName: 'Alex Rivera',
    createdAt: nowIso, updatedAt: nowIso,
  });
  return {
    phone,
    partnerId,
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
    transferRepo: createTransferRepo(db),
    ticketRepo: createTicketRepo(db),
    outboxRepo: createOutboxRepo(db),
    recallDb: db,
    helpDb: db,
    senderCancel: (p: string, id: string) => cancelWithinWindow(db, p, id, { via: 'bot' }),
  };
}
type Ctx = Awaited<ReturnType<typeof buildCtx>>;

/** A consumer transfer minted through the pay page (awaiting_payment). */
async function mint(ctx: Ctx): Promise<string> {
  const created = await mintViaPayPage(
    {
      amount_usd: 50, // six mints stay inside the T0 daily cap
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'bank_transfer',
    },
    ctx,
    db,
  );
  expect(created.error).toBeUndefined();
  return created.transfer_id as string;
}

async function paid(ctx: Ctx, minutesAgo: number): Promise<string> {
  const id = await mint(ctx);
  await ctx.store.updateTransferFromWebhook(id, 'paid');
  await db.execute(sql`UPDATE transfers SET paid_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${id}`);
  return id;
}

async function delivered(ctx: Ctx, hoursAgo: number): Promise<string> {
  const id = await mint(ctx);
  await ctx.store.updateTransferFromWebhook(id, 'paid');
  await ctx.store.updateTransferFromWebhook(id, 'delivered');
  await db.execute(sql`
    UPDATE transfers SET paid_at = now() - make_interval(hours => ${hoursAgo + 1}),
      delivered_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${id}`);
  return id;
}

async function setRow(id: string, set: 'b2b' | 'test' | 'in_review' | 'cancelled' | 'refund_completed'): Promise<void> {
  if (set === 'b2b') await db.execute(sql`UPDATE transfers SET transfer_type = 'b2b' WHERE id = ${id}`);
  if (set === 'test') await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${id}`);
  if (set === 'in_review') await db.execute(sql`UPDATE transfers SET status = 'in_review' WHERE id = ${id}`);
  if (set === 'cancelled') await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${id}`);
  if (set === 'refund_completed') await db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${id}`);
}

async function ticketsOf(id: string) {
  return (await createTicketRepo(db).listByCustomer(PHONE)).filter((t) => t.transferId === id);
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function expectNoRefusalWords(r: Record<string, unknown>) {
  const json = JSON.stringify(r).toLowerCase();
  expect(json).not.toContain('no longer possible');
  for (const w of ['review', 'hold', 'compliance', 'sanction', 'screening', 'fraud', 'complaint']) {
    expect(json, w).not.toContain(w);
  }
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('open_recall_dispute opens the regulatory case (P11, T13)', { retry: 0 }, () => {
  it('delivered 3 days ago, wrong_recipient -> an error_notice case', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 72);
    const before = Date.now();
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_recipient' }, ctx);
    const after = Date.now();
    expect(r.opened).toBe(true);
    expect(String(r.case_id)).toMatch(/^tk_/);
    const [t] = await ticketsOf(id);
    expect(t.id).toBe(r.case_id);
    expect(t.regClass).toBe('error_notice');
    expect(t.priority).toBe('urgent');
    expect(t.category).toBe('refund');
    expect(t.subject).toBe('Recall request: wrong_recipient');
    const due = Date.parse(t.dueAt!);
    expect(due).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(due).toBeLessThanOrEqual(after + 90 * DAY);
    expect(r.due_date).toBe(ymd(due));
    expect(r.reply_to_customer).toBe(
      caseOpenedReply({ caseId: t.id, dueAt: t.dueAt!, providerLine: null, reused: false, surface: 'chat' }),
    );
    expect(r.reply_hint).toBeUndefined();
    expect(r.cancel_possible).toBeUndefined();
    expectNoRefusalWords(r);
  });

  it('delivered 200 days ago -> a complaint case with the 15-day date', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 200 * 24);
    const before = Date.now();
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'not_received' }, ctx);
    expect(r.opened).toBe(true);
    const [t] = await ticketsOf(id);
    expect(t.regClass).toBe('complaint');
    expect(Date.parse(t.dueAt!)).toBeGreaterThanOrEqual(before + 15 * DAY);
    expect(Date.parse(t.dueAt!)).toBeLessThan(before + 16 * DAY);
    expect(String(r.reply_to_customer)).toContain(new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(t.dueAt!)));
    expectNoRefusalWords(r);
  });

  it.each(['awaiting', 'cancelled', 'refund_completed'] as const)('%s row -> a complaint case, never an error_code', async (state) => {
    const ctx = await buildCtx(fakeRedis());
    const id = state === 'awaiting' ? await mint(ctx) : await delivered(ctx, 300 * 24);
    if (state !== 'awaiting') await setRow(id, state);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBeUndefined();
    expect(r.opened).toBe(true);
    const [t] = await ticketsOf(id);
    expect(t.regClass).toBe('complaint');
  });

  it('paid 40 minutes ago -> error_notice with refund_possible: true', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await paid(ctx, 40);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, ctx);
    expect(r.opened).toBe(true);
    expect(r.refund_possible).toBe(true);
    expect(r.cancel_possible).toBeUndefined();
    expect((await ticketsOf(id))[0].regClass).toBe('error_notice');
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('paid 10 minutes ago, wrong_amount -> the case opens AND the cancel is offered (DP13)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await paid(ctx, 10);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, ctx);
    const [t] = await ticketsOf(id);
    expect(t.regClass).toBe('error_notice');
    expect(r).toEqual({
      opened: true,
      case_id: t.id,
      due_date: t.dueAt!.slice(0, 10),
      reply_to_customer: caseOpenedReply({ caseId: t.id, dueAt: t.dueAt!, providerLine: null, reused: false, surface: 'chat' }),
      cancel_possible: true,
      reply_hint: CANCEL_REPLY_HINT.confirm,
    });
    // Nothing is cancelled by the report itself.
    expect((await ctx.store.getTransfer(id))?.status).toBe('paid');
  });

  it('paid 10 minutes ago, unauthorized -> a fraud_report case + the cancel offer (critic M7)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await paid(ctx, 10);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'unauthorized' }, ctx);
    expect(r.opened).toBe(true);
    expect(r.cancel_possible).toBe(true);
    expect(r.reply_hint).toBe(CANCEL_REPLY_HINT.confirm);
    expect((await ticketsOf(id))[0].regClass).toBe('fraud_report');
  });

  it('no transfer_id and two or more transfers -> which_transfer, NO ticket (critic P7)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const a = await delivered(ctx, 48);
    const b = await delivered(ctx, 30);
    const r = await executeTool('open_recall_dispute', { reason: 'not_received' }, ctx);
    expect(r.error_code).toBe('which_transfer');
    expect(r.reply_hint).toBe('ask which transfer they mean');
    const ids = r.transfer_ids as string[];
    expect(new Set(ids)).toEqual(new Set([a, b]));
    const recent = await ctx.store.listTransfersByPhone(ctx.partnerId, ctx.phone, 10);
    expect(ids).toEqual(recent.map((t) => t.id)); // newest first, as the store lists them
    expect(r.opened).toBeUndefined();
    expect(await createTicketRepo(db).listByCustomer(PHONE)).toHaveLength(0);
  });

  it('which_transfer lists at most 5 ids', async () => {
    const ctx = await buildCtx(fakeRedis());
    for (let i = 0; i < 6; i++) await mint(ctx);
    const r = await executeTool('open_recall_dispute', { reason: 'other' }, ctx);
    expect(r.error_code).toBe('which_transfer');
    expect(r.transfer_ids).toHaveLength(5);
    expect(await createTicketRepo(db).listByCustomer(PHONE)).toHaveLength(0);
  });

  it('no transfer_id and exactly one transfer -> the case opens on it; none -> no_transfer_found', async () => {
    const ctx = await buildCtx(fakeRedis());
    const none = await executeTool('open_recall_dispute', { reason: 'other' }, ctx);
    expect(none.error_code).toBe('no_transfer_found');
    const id = await delivered(ctx, 50);
    const r = await executeTool('open_recall_dispute', { reason: 'other' }, ctx);
    expect(r.opened).toBe(true);
    expect((await ticketsOf(id))[0].id).toBe(r.case_id);
  });

  it('in_review row -> an error_notice case; the reply has no review/hold/compliance word', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await paid(ctx, 60);
    await setRow(id, 'in_review');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'not_received' }, ctx);
    expect(r.opened).toBe(true);
    expect((await ticketsOf(id))[0].regClass).toBe('error_notice');
    expectNoRefusalWords(r);
  });

  it("'unauthorized' on a delivered and on an awaiting row -> fraud_report", async () => {
    const ctx = await buildCtx(fakeRedis());
    const d = await delivered(ctx, 5);
    const rd = await executeTool('open_recall_dispute', { transfer_id: d, reason: 'unauthorized' }, ctx);
    expect(rd.opened).toBe(true);
    expect((await ticketsOf(d))[0].regClass).toBe('fraud_report');
    const a = await mint(ctx);
    const ra = await executeTool('open_recall_dispute', { transfer_id: a, reason: 'unauthorized' }, ctx);
    expect(ra.opened).toBe(true);
    expect((await ticketsOf(a))[0].regClass).toBe('fraud_report');
    expectNoRefusalWords(rd);
  });

  it('a second report on the same transfer and class reuses the case', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 30);
    const first = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_recipient' }, ctx);
    const second = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'not_received' }, ctx);
    expect(second.case_id).toBe(first.case_id);
    expect(second.due_date).toBe(first.due_date);
    expect(String(second.reply_to_customer).startsWith('We have added this to your open case.')).toBe(true);
    expect(await ticketsOf(id)).toHaveLength(1);
  });

  it('the cap, the web step-up and support_off never refuse a classed case (DP9)', async () => {
    vi.stubEnv('CUSTOMER_MFA_REQUIRED', 'true');
    const ctx = await buildCtx(fakeRedis());
    const repo = createTicketRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({ id: `tk_pre${i}`, partnerId: 'default', kind: 'customer', customerPhone: PHONE, subject: `existing ${i}`, body: 'open case' });
    }
    expect(await ctx.customerStore.enableMfa(ctx.partnerId, ctx.phone, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe(true);
    await ctx.partnerStore.ensureDefaultPartner();
    await createPartnerRepo(db).updateSupportConfig(ctx.partnerId, (prev) => ({ ...prev, enableSupportPortal: false }));
    const id = await delivered(ctx, 30);
    const web = { ...ctx, channel: 'web' as const };
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, web);
    expect(r.opened).toBe(true);
    const portal = { ...web, webStepUp: { surface: 'portal' as const, fresh: false } };
    const r2 = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, portal);
    expect(r2.opened).toBe(true);
    expect(r2.case_id).toBe(r.case_id);
  });

  it('b2b delivered within 24h -> today\'s unclassed recall case', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 2);
    await setRow(id, 'b2b');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.opened).toBe(true);
    expect(r.reply_to_customer).toBeUndefined();
    const [t] = await ticketsOf(id);
    expect(t.regClass).toBeUndefined();
    expect(t.category).toBe('refund');
  });

  it.each(['b2b', 'test'] as const)('%s delivered 25 h ago -> not_recall_eligible, offers request_human_help, no ticket', async (kind) => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 25);
    await setRow(id, kind);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBe('not_recall_eligible');
    expect(String(r.reply_hint)).toContain('request_human_help');
    expect(String(r.reply_hint)).not.toContain('no longer possible');
    expect(await ticketsOf(id)).toHaveLength(0);
  });

  it('sandbox row delivered within 24h -> the unclassed recall case (not_consumer)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 2);
    await setRow(id, 'test');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.opened).toBe(true);
    expect((await ticketsOf(id))[0].regClass).toBeUndefined();
  });

  it('the provider line is in the reply', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 30);
    const line = 'Payments by Acme Remit Inc, licensed by the State Banking Dept';
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, { ...ctx, providerLine: line });
    expect(String(r.reply_to_customer)).toContain(line);
  });
});

describe('request_refund, request_human_help and cancel_bill point to the case (P11, T13)', { retry: 0 }, () => {
  it('request_refund on a row delivered 25 h ago -> use_recall with the transfer id', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await delivered(ctx, 25);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r).toEqual({
      error_code: 'use_recall',
      transfer_id: id,
      reply_hint: 'delivered earlier — if the customer reports a problem with it, call open_recall_dispute with the reason; it opens a case with a date',
    });
    expect(String(r.reply_hint)).not.toContain('no longer possible');
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
    expect(await ticketsOf(id)).toHaveLength(0);
  });

  it('request_human_help complaint -> case_id, due_date and reply_to_customer; today\'s reply_hint stays', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_human_help', { reason: 'complaint', summary: 'unhappy' }, ctx);
    const [t] = await createTicketRepo(db).listByCustomer(PHONE);
    expect(t.regClass).toBe('complaint');
    expect(r).toEqual({
      case_id: t.id,
      reply_hint: `When a teammate replies, you'll get a message here with a link to read it (sign in with this WhatsApp number). Your case number is ${t.id}.`,
      due_date: t.dueAt!.slice(0, 10),
      reply_to_customer: caseOpenedReply({ caseId: t.id, dueAt: t.dueAt!, providerLine: null, reused: false, surface: 'chat' }),
    });
    // A second complaint on the already classed case keeps today's keys.
    const again = await executeTool('request_human_help', { reason: 'complaint' }, ctx);
    expect(Object.keys(again).sort()).toEqual(['case_id', 'reply_hint']);
    expect(again.case_id).toBe(t.id);
  });

  it('request_human_help question -> exactly today\'s keys', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_human_help', { reason: 'question' }, ctx);
    expect(Object.keys(r).sort()).toEqual(['case_id', 'reply_hint']);
  });

  it('request_human_help: a complaint that stamps the first class on an open question case adds the case text (reused)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const q = await executeTool('request_human_help', { reason: 'question' }, ctx);
    const r = await executeTool('request_human_help', { reason: 'complaint' }, ctx);
    expect(r.case_id).toBe(q.case_id);
    expect(String(r.reply_to_customer).startsWith('We have added this to your open case.')).toBe(true);
    expect(typeof r.due_date).toBe('string');
  });

  it('cancel_bill on a bill delivered 25 h ago keeps its "recall window" answer; within 24 h -> recall_opened', async () => {
    const ctx = await buildCtx(fakeRedis());
    await db.execute(sql`TRUNCATE b2b_invoices`);
    await ctx.store.saveB2bInvoice({
      id: 'inv_t13', partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: ctx.phone, lineItems: [{ description: 'Widgets', qty: 40, unitAmountUsd: 10 }],
      amountUsd: 400, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
    });
    const created = await mintViaPayPage({
      amount_source: 400, recipient_name: 'Globex Trading LLC', recipient_phone: '919876543210',
      funding_method: 'ach_pull', entity_type: 'business', sender_business_name: 'Acme Imports Ltd',
      recipient_business_name: 'Globex Trading LLC', invoice_id: 'inv_t13',
    }, ctx, db);
    const id = created.transfer_id as string;
    await ctx.store.updateTransferFromWebhook(id, 'paid');
    await ctx.store.updateTransferFromWebhook(id, 'delivered');
    await db.execute(sql`UPDATE transfers SET delivered_at = now() - interval '25 hours' WHERE id = ${id}`);
    const late = await executeTool('cancel_bill', {}, ctx);
    expect(late.cancelled).toBe(false);
    expect(String(late.reply_hint).toLowerCase()).toContain('recall window');
    expect(await ticketsOf(id)).toHaveLength(0);
    await db.execute(sql`UPDATE transfers SET delivered_at = now() - interval '2 hours' WHERE id = ${id}`);
    const early = await executeTool('cancel_bill', {}, ctx);
    expect(early.recall_opened).toBe(true);
    expect((await ticketsOf(id))[0].regClass).toBeUndefined();
  });
});
