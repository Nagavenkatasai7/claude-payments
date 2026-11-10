// 2026-11-10 (db password and logs review, C6): a failed store/DB call inside a
// chat tool must not print the query's bound values or the Postgres detail.
// Each of these tools used to `console.warn('label', err)`, which util.inspect
// prints whole (message with params, the params array, the cause with detail).
// They now log through logWarn (scope + scrubbed message, one JSON line), and
// the customer-facing result of the fail-soft path is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTool } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { captureConsole, expectSafeLog, fakeQueryError as queryError, FAKE_NAME, FAKE_PHONE_DIGITS as PHONE } from './helpers-db-error-log';

let db: Db;

async function buildCtx() {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso, fullName: 'Alex Rivera',
    createdAt: nowIso, updatedAt: nowIso,
  });
  return {
    phone: PHONE,
    partnerId: 'default',
    store,
    customerStore,
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: createPartnerStore(db),
    turn: { isNewConversation: false } as const,
  } as unknown as Parameters<typeof executeTool>[2];
}

function expectSafe(c: ReturnType<typeof captureConsole>, scope: string): Record<string, unknown> {
  const line = expectSafeLog(c, scope);
  expect(line.partnerId).toBe('default');
  return line;
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tools.ts: a failed store query is logged through logWarn, without its values', () => {
  it('list_recent_transfers (listTransfersByPhone) fails soft to an empty list', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listTransfersByPhone').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('list_recent_transfers', {}, ctx);
    expect(r).toMatchObject({ transfers: [], count: 0 });
    expect(typeof r.history_url).toBe('string');
    const line = expectSafe(c, 'list_recent_transfers.lookup-failed');
    expect(String(line.msg)).toContain('[57P01]');
  });

  it('present_bill (getUnpaidInvoiceByBuyer) fails soft to no bill', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'getUnpaidInvoiceByBuyer').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('present_bill', {}, ctx);
    expect(r).toEqual({ has_bill: false });
    expectSafe(c, 'present_bill.lookup-failed');
  });

  it('register_seller (createSeller) keeps its retry reply', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'createSeller').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    expect(r).toEqual({
      registered: false,
      reply_to_customer: "I couldn't complete your seller registration just now — please try again in a moment.",
    });
    expectSafe(c, 'register_seller.create-failed');
  });

  it('register_seller (sanctions screen) logs the error name only and still fails closed', async () => {
    const { MockSanctionsScreener } = await import('@/lib/providers/sanctions-provider');
    // A screener whose error echoes the screened business name.
    vi.spyOn(MockSanctionsScreener.prototype, 'screen').mockRejectedValueOnce(new TypeError(`bad input ${FAKE_NAME}`));
    const ctx = await buildCtx();
    const c = captureConsole();
    const r = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    expect(r.onboarding_url).toBeUndefined();
    expect((await ctx.store.getSeller(PHONE, 'default'))?.kycReviewState).toBe('needs_review');
    const line = expectSafe(c, 'register_seller.screen-failed');
    expect(line.msg).toBe('TypeError');
  });

  it('list_saved_recipients (listRecipients) fails soft to none', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listRecipients').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('list_saved_recipients', {}, ctx);
    expect(r).toEqual({ recipients: [] });
    expectSafe(c, 'list_saved_recipients.lookup-failed');
  });

  it('resolve_recipient (listRecipients) fails soft to no match', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listRecipients').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r).toEqual({ match: 'none' });
    expectSafe(c, 'resolve_recipient.lookup-failed');
  });

  it('check_bill_status (listTransfersByPhone) fails soft to not found', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listTransfersByPhone').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('check_bill_status', {}, ctx);
    expect(r).toEqual({ found: false });
    expectSafe(c, 'check_bill_status.lookup-failed');
  });

  it('check_bill_status (getB2bInvoiceScoped) still answers from the transfer', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listTransfersByPhone').mockResolvedValue([
      { id: 'tr_b2b1', phone: PHONE, transferType: 'b2b', invoiceId: 'inv_x', status: 'paid' } as never,
    ]);
    vi.spyOn(ctx.store, 'getB2bInvoiceScoped').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('check_bill_status', {}, ctx);
    expect(r).toMatchObject({ found: true, transfer_id: 'tr_b2b1', status: 'paid' });
    expect(r.seller_business_name).toBeUndefined();
    expectSafe(c, 'check_bill_status.invoice-lookup-failed');
  });

  it('cancel_bill (listTransfersByPhone) treats a failed read as no bill', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'listTransfersByPhone').mockRejectedValue(queryError());
    const c = captureConsole();
    await executeTool('cancel_bill', {}, ctx);
    expectSafe(c, 'cancel_bill.lookup-failed');
  });

  it('dispute_bill (getUnpaidInvoiceByBuyer) answers no open bill', async () => {
    const ctx = await buildCtx();
    vi.spyOn(ctx.store, 'getUnpaidInvoiceByBuyer').mockRejectedValue(queryError());
    const c = captureConsole();
    const r = await executeTool('dispute_bill', { reason: 'other' }, ctx);
    expect(r).toEqual({ error_code: 'no_open_bill', reply_hint: "I don't see an open bill to dispute." });
    expectSafe(c, 'dispute_bill.lookup-failed');
  });

  it('get_quote (routeSelector) fail-opens to mid', async () => {
    const ctx = await buildCtx();
    const baseline = await executeTool('get_quote', { amount_usd: 400, funding_method: 'bank_transfer' }, ctx);
    const c = captureConsole();
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => { throw queryError(); } },
    );
    expect(r).toEqual(baseline);
    expectSafe(c, 'quote.route-select-failed');
  });
});
