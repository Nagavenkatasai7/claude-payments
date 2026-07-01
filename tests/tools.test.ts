import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  executeTool,
  toolSchemas,
  toolSchemasForChannel,
  WEB_TOOL_ALLOWLIST,
  WEB_ONLY_TOOLS,
  buildApproveSummary,
  maskAccount,
} from '@/lib/tools';
import type { CurrencyCode, Quote } from '@/lib/types';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { selectSettlementRoute } from '@/lib/partner-rates';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { PartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';

const PHONE = '15551234567';
const MOCK_RATE = 85.0;

// Partner store is pg-backed (Stage 2a cutover): freshDb() truncates the shared
// PGlite and reseeds the 'default' partner, so it runs per-test in beforeEach.
let db: Db;

async function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE) {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  // Phase 3: the verify-before-send gate blocks any non-'verified' sender. These
  // existing-behavior tests exercise the send path, so seed the default customer
  // as verified up front (still T0 within the 3-day window → cap behavior intact).
  // Customers live in Postgres now, so the seed is an awaited saveCustomer;
  // tests that want a different status saveCustomer() over it afterward.
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  return {
    phone,
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore,
    monthlyVolumeStore,
    kycProvider,
    partnerStore: createPartnerStore(db), // pg-backed (Stage 2a cutover)
    // Refund seam: the guarded refund-lifecycle writer, bound to the PGlite db
    // (the prod fallback would build one over getDb()'s Neon Pool).
    transferRepo: createTransferRepo(db),
    // Recall-dispute seam: the support-ticket repo, bound to the PGlite db.
    ticketRepo: createTicketRepo(db),
    // Triage-enqueue seam: the outbox repo open_recall_dispute queues the
    // out-of-band 'ticket.triage' effect on, bound to the PGlite db (the prod
    // fallback would build one over getDb()'s Neon Pool).
    outboxRepo: createOutboxRepo(db),
  };
}

function stubFetch(rate: number = MOCK_RATE) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: rate } }),
    }),
  );
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toolSchemas', () => {
  it('exposes all twenty-six tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_bill',
      'cancel_draft',
      'cancel_schedule',
      'capture_corridor_request',
      'check_bill_status',
      'check_payment_status',
      'check_send_limit',
      'create_invoice',
      'create_schedule',
      'create_transfer',
      'dispute_bill',
      'generate_payment_link',
      'get_quote',
      'list_recent_transfers',
      'list_saved_recipients',
      'list_schedules',
      'open_recall_dispute',
      'present_bill',
      'register_seller',
      'repeat_transfer',
      'request_refund',
      'resolve_recipient',
      'send_approve_picker',
      'send_recipient_picker',
      'update_recipient_phone',
      'validate_phone',
    ]);
  });

  it('request_refund schema makes transfer_id OPTIONAL', () => {
    const rr = toolSchemas.find((t) => t.function.name === 'request_refund')!;
    // transfer_id is no longer required — the tool resolves the latest
    // refund-relevant transfer when it is omitted.
    expect(rr.function.parameters.required ?? []).not.toContain('transfer_id');
    const props = rr.function.parameters.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['transfer_id']);
  });

  it('open_recall_dispute schema requires reason and makes transfer_id optional', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'open_recall_dispute')!;
    expect(tool.function.parameters.required).toEqual(['reason']);
    const props = tool.function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual(['reason', 'transfer_id']);
    expect(props.reason.enum).toEqual(['wrong_recipient', 'wrong_amount', 'not_received', 'unauthorized', 'other']);
  });

  it('get_quote schema has amount_usd and funding_method (no payout_method)', () => {
    const getQuote = toolSchemas.find((t) => t.function.name === 'get_quote')!;
    const props = getQuote.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('amount_usd');
    expect(props).toHaveProperty('funding_method');
    expect(props).not.toHaveProperty('payout_method');
  });

  it('create_transfer schema includes funding_method and recipient_phone', () => {
    const ct = toolSchemas.find((t) => t.function.name === 'create_transfer')!;
    const props = ct.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('funding_method');
    expect(props).toHaveProperty('recipient_phone');
  });

  // Item 2: bank details are never collected in chat — the secure pay page
  // gathers them. The bot no longer REQUIRES payout_destination/payout_method on
  // the tools that previously did.
  it('send_approve_picker no longer requires payout_destination or payout_method', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'send_approve_picker')!;
    const required = tool.function.parameters.required as string[];
    expect(required).not.toContain('payout_destination');
    expect(required).not.toContain('payout_method');
    // The recipient-identity fields stay required.
    expect(required).toContain('recipient_name');
    expect(required).toContain('recipient_phone');
  });

  it('create_transfer no longer requires payout_destination or payout_method', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'create_transfer')!;
    const required = tool.function.parameters.required as string[];
    expect(required).not.toContain('payout_destination');
    expect(required).not.toContain('payout_method');
  });

  it('create_schedule no longer requires payout_destination or payout_method', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'create_schedule')!;
    const required = tool.function.parameters.required as string[];
    expect(required).not.toContain('payout_destination');
    expect(required).not.toContain('payout_method');
  });

  it('update_recipient_phone schema has transfer_id and recipient_phone', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'update_recipient_phone')!;
    const props = tool.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('transfer_id');
    expect(props).toHaveProperty('recipient_phone');
    expect(tool.function.parameters.required).toContain('transfer_id');
    expect(tool.function.parameters.required).toContain('recipient_phone');
  });
});

describe('capture_corridor_request', () => {
  it('saves a lead and returns { saved: true, request_id }', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {
      destination_country: 'UAE',
      approx_amount: 500,
      approx_currency: 'usd',
    }, ctx);
    expect(result.saved).toBe(true);
    expect(typeof result.request_id).toBe('string');
    // Verify it was persisted
    const leads = await ctx.store.listCorridorRequests();
    expect(leads).toHaveLength(1);
    expect(leads[0].destinationCountry).toBe('UAE');
    expect(leads[0].approxAmount).toBe(500);
    expect(leads[0].approxCurrency).toBe('USD'); // uppercased
    expect(leads[0].senderPhone).toBe(PHONE);
  });

  it('returns { error } when destination_country is missing', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {}, ctx);
    expect(result.error).toBeDefined();
    expect(result.saved).toBeUndefined();
  });

  it('saves a lead without optional fields', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {
      destination_country: 'Pakistan',
    }, ctx);
    expect(result.saved).toBe(true);
    const leads = await ctx.store.listCorridorRequests();
    expect(leads[0].approxAmount).toBeUndefined();
    expect(leads[0].approxCurrency).toBeUndefined();
  });

  it('does NOT return sent: true (agent still sends a text reply)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {
      destination_country: 'UAE',
    }, ctx);
    expect(result.sent).toBeUndefined();
  });
});

describe('executeTool', () => {
  it('get_quote returns a free first quote', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' },
      ctx,
    );
    expect(result.fee_usd).toBe(0);
    expect(result.amount_inr).toBe(Math.round(500 * MOCK_RATE));
  });

  it('get_quote surfaces a validation error as { error }', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 5, funding_method: 'bank_transfer' },
      ctx,
    );
    expect(result.error).toMatch(/between/i);
  });

  // Regression for the 2026-06-16 prod bug: an Indian (+91) sender → US recipient
  // (₹→$). Stub Frankfurter so from=INR returns a live USD rate (toInr identity 1).
  function stubInrToUsd() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=INR')) return { ok: true, json: async () => ({ rates: { USD: 0.0118 } }) };
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
  }

  it('any-to-any: INR sender → US recipient, send ₹20,000 succeeds (the 6/16 bug, fixed)', async () => {
    stubInrToUsd();
    const ctx = await buildCtx(fakeRedis(), '919876543210'); // Indian sender ⇒ INR source
    const r = await executeTool(
      'get_quote',
      { amount_source: 20000, funding_method: 'bank_transfer', destination_country: 'US' },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.source_currency).toBe('INR');
    expect(r.destination_currency).toBe('USD');
    expect(r.amount_source).toBe(20000);
    expect(r.amount_dest as number).toBeCloseTo(236, 0); // ₹20,000 × 0.0118 ≈ $236 received
  });

  it('any-to-any: a sub-minimum INR amount is refused IN RUPEES, never "$10" (the exact failure value)', async () => {
    stubInrToUsd();
    const ctx = await buildCtx(fakeRedis(), '919876543210');
    // ₹210 ≈ $2.48 — the value the bot wrongly passed after pre-converting. Now a clear ₹ message.
    const r = await executeTool(
      'get_quote',
      { amount_source: 210, funding_method: 'bank_transfer', destination_country: 'US' },
      ctx,
    );
    expect(typeof r.error).toBe('string');
    expect(r.error as string).toContain('₹');
    expect(r.error as string).not.toContain('$10');
  });

  it('any-to-any: receive-first — INR sender, "Dad gets $250" back-solves correctly', async () => {
    stubInrToUsd();
    const ctx = await buildCtx(fakeRedis(), '919876543210');
    const r = await executeTool(
      'get_quote',
      { amount_dest: 250, funding_method: 'bank_transfer', destination_country: 'US' },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.destination_currency).toBe('USD');
    expect(r.amount_dest as number).toBeCloseTo(250, 0);          // recipient gets $250
    expect(r.amount_source as number).toBeCloseTo(250 / 0.0118, 0); // ≈ ₹21,186 send
  });

  it('any-to-any: amount_usd / amount_inr still work as back-compat aliases', async () => {
    stubInrToUsd();
    const ctx = await buildCtx(fakeRedis(), '919876543210');
    const a = await executeTool('get_quote', { amount_usd: 20000, funding_method: 'bank_transfer', destination_country: 'US' }, ctx);
    expect(a.error).toBeUndefined();
    expect(a.amount_source).toBe(20000);
    expect(a.amount_dest as number).toBeCloseTo(236, 0);
  });

  it('validate_phone surfaces the detected destination country for a known calling code', async () => {
    const ctx = await buildCtx(fakeRedis());
    const us = await executeTool('validate_phone', { phone: '+1 555 123 4567' }, ctx);
    expect(us.valid).toBe(true);
    expect(us.normalized).toBe('15551234567');
    expect(us.detected_destination_country).toBe('US');

    const inn = await executeTool('validate_phone', { phone: '+91 98765 43210' }, ctx);
    expect(inn.detected_destination_country).toBe('IN');
  });

  it('validate_phone omits detected_destination_country for a bare local number (⇒ agent asks)', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 9876543210 normalizes to a valid-length number with no recognizable calling code.
    const r = await executeTool('validate_phone', { phone: '9876543210' }, ctx);
    expect(r.valid).toBe(true);
    expect(r.detected_destination_country).toBeUndefined();
  });

  it('get_quote uses credit_card surcharge for repeat transfers', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    // First transfer (free)
    await executeTool(
      'create_transfer',
      {
        amount_usd: 100,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'credit_card',
      },
      ctx,
    );
    resetRateCacheForTests();
    stubFetch();
    // Second quote (repeat, credit_card)
    const result = await executeTool(
      'get_quote',
      { amount_usd: 100, funding_method: 'credit_card' },
      ctx,
    );
    // fee = 2.99 + 3 = 5.99
    expect(result.fee_usd).toBe(5.99);
  });

  it('create_transfer persists a transfer and increments the user count', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '+91 98765 43210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'debit_card',
      },
      ctx,
    );
    expect(result.status).toBe('awaiting_payment');
    expect(result.compliance_status).toBe('cleared');
    const saved = await ctx.store.getTransfer(result.transfer_id as string);
    expect(saved?.recipientName).toBe('Mom');
    expect(saved?.fundingMethod).toBe('debit_card');
    // recipientPhone should be normalized to digits only
    expect(saved?.recipientPhone).toBe('919876543210');
    expect(await ctx.store.getTransferCount(PHONE)).toBe(1);
  });

  it('create_transfer with watchlisted recipient returns blocked status', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 200,
        recipient_name: 'John Doe',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'john@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    expect(result.compliance_status).toBe('blocked');
    expect(result.status).toBe('blocked');

    // generate_payment_link for a blocked transfer should return an error
    const linkResult = await executeTool(
      'generate_payment_link',
      { transfer_id: result.transfer_id },
      ctx,
    );
    expect(linkResult.error).toBeDefined();
    expect(linkResult.error).toMatch(/compliance/i);
  });

  it('create_transfer returns an error and does NOT persist when recipient_phone is missing', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'debit_card',
        // recipient_phone intentionally omitted
      },
      ctx,
    );
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    // No transfer should have been persisted (transfers live in Postgres now)
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('create_transfer returns an error and does NOT persist when recipient_phone is invalid (too short)', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '12345',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'debit_card',
      },
      ctx,
    );
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('generate_payment_link builds a URL for an existing transfer', async () => {
    const ctx = await buildCtx(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    const link = await executeTool(
      'generate_payment_link',
      { transfer_id: created.transfer_id },
      ctx,
    );
    expect(link.url).toBe(
      `https://smartremit.test/pay/${created.transfer_id}`,
    );
  });

  it('check_payment_status reports a transfer status', async () => {
    const ctx = await buildCtx(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    const status = await executeTool(
      'check_payment_status',
      { transfer_id: created.transfer_id },
      ctx,
    );
    expect(status.status).toBe('awaiting_payment');
  });

  it('returns an error for an unknown tool', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('nope', {}, ctx);
    expect(result.error).toMatch(/unknown tool/i);
  });

  describe('update_recipient_phone', () => {
    it('sets the normalized recipientPhone on an existing transfer', async () => {
      const ctx = await buildCtx(fakeRedis());
      // Create a transfer first (with valid phone for the create_transfer enforcement)
      const created = await executeTool(
        'create_transfer',
        {
          amount_usd: 200,
          recipient_name: 'Dad',
          recipient_phone: '919876543210',
          payout_method: 'upi',
          payout_destination: 'dad@upi',
          funding_method: 'bank_transfer',
        },
        ctx,
      );
      const transferId = created.transfer_id as string;

      // Update with a formatted phone
      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: transferId, recipient_phone: '+91 98765 11111' },
        ctx,
      );
      expect(result.error).toBeUndefined();
      expect(result.recipient_phone).toBe('919876511111');
      expect(result.transfer_id).toBe(transferId);

      // Verify in the store
      const saved = await ctx.store.getTransfer(transferId);
      expect(saved?.recipientPhone).toBe('919876511111');
    });

    it('returns an error for an unknown transfer id', async () => {
      const ctx = await buildCtx(fakeRedis());
      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: 'nonexistent-id', recipient_phone: '919876543210' },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not found/i);
    });

    it('returns an error for an invalid phone number', async () => {
      const ctx = await buildCtx(fakeRedis());
      const created = await executeTool(
        'create_transfer',
        {
          amount_usd: 200,
          recipient_name: 'Dad',
          recipient_phone: '919876543210',
          payout_method: 'upi',
          payout_destination: 'dad@upi',
          funding_method: 'bank_transfer',
        },
        ctx,
      );
      const transferId = created.transfer_id as string;

      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: transferId, recipient_phone: '123' },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/valid/i);

      // Phone should remain unchanged
      const saved = await ctx.store.getTransfer(transferId);
      expect(saved?.recipientPhone).toBe('919876543210');
    });
  });
});

describe('create_schedule — end_date guardrail (QA #7)', () => {
  it('stores a valid end_date on the schedule', async () => {
    const c = await buildCtx(fakeRedis());
    const r = await executeTool('create_schedule', {
      amount_usd: 150, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 10,
      end_date: '2027-12-31',
    }, c);
    expect(r.schedule_id).toBeTruthy();
    expect(r.end_date).toBe('2027-12-31');
    const saved = await c.scheduleStore.getSchedule(r.schedule_id as string);
    expect(saved?.endDate).toBe('2027-12-31');
  });

  it('ignores an invalid end_date (non-parseable string) and stores no endDate', async () => {
    const c = await buildCtx(fakeRedis());
    const r = await executeTool('create_schedule', {
      amount_usd: 150, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 10,
      end_date: 'not-a-date',
    }, c);
    expect(r.schedule_id).toBeTruthy();
    const saved = await c.scheduleStore.getSchedule(r.schedule_id as string);
    expect(saved?.endDate).toBeUndefined();
  });

  it('create_schedule schema includes an end_date property', () => {
    const cs = toolSchemas.find((t) => t.function.name === 'create_schedule')!;
    const props = cs.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('end_date');
    expect((props.end_date as Record<string, unknown>).type).toBe('string');
  });
});

describe('schedule tools', () => {
  it('create_schedule saves a monthly schedule', async () => {
    const c = await buildCtx(fakeRedis());
    const r = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '+91 9133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    expect(r.schedule_id).toBeTruthy();
    const saved = await c.scheduleStore.getSchedule(r.schedule_id as string);
    expect(saved?.frequency).toBe('monthly');
    expect(saved?.recipientPhone).toBe('919133001840');
  });

  it('create_schedule rejects an out-of-range day_of_month', async () => {
    const r = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 31,
    }, await buildCtx(fakeRedis()));
    expect(r.error).toMatch(/day of the month/i);
  });

  it('list_schedules returns only this customer active schedules', async () => {
    const c = await buildCtx(fakeRedis());
    await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'weekly', day_of_week: 5,
    }, c);
    const r = await executeTool('list_schedules', {}, c);
    expect((r.schedules as unknown[]).length).toBe(1);
  });

  it('cancel_schedule cancels an existing schedule', async () => {
    const c = await buildCtx(fakeRedis());
    const created = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, c);
    const saved = await c.scheduleStore.getSchedule(created.schedule_id as string);
    expect(saved?.status).toBe('cancelled');
  });

  it('create_schedule writes partnerId from the owning customer', async () => {
    const c = await buildCtx(fakeRedis());
    await seedPartner(db, 'acme'); // schedules/customers carry a REAL FK to partners now
    await c.customerStore.saveCustomer({
      senderPhone: PHONE,
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const created = await executeTool('create_schedule', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    const saved = await c.scheduleStore.getSchedule(created.schedule_id as string);
    expect(saved?.partnerId).toBe('acme');
  });
});

describe('check_send_limit', () => {
  it('T0 brand-new customer with no spend → within_cap true with day_of_window=1', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 100 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.tier).toBe('T0');
    expect(r.daily_cap_usd).toBe(500);
    expect(r.today_remaining_usd).toBe(500);
    expect(r.day_of_window).toBe(1);
    // The default partner has NOT opted into verify-before-send → no kyc_url
    // even for T0 (the gate-ON variant is covered in its own suite below).
    expect(r.kyc_url).toBeUndefined();
  });

  it('T0 customer over the per-transfer cap returns reason=over_per_transfer_cap', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 700 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
  });

  it('T0 customer over the daily cap (cumulative) returns reason=over_daily_cap', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550001111');
    await ctx.customerStore.upsertOnFirstInbound('15550001111');
    await ctx.dailyVolumeStore.addCents('15550001111', 30_000); // $300 today
    const r = await executeTool('check_send_limit', { amount_usd: 300 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_used_usd).toBe(300);
    expect(r.today_remaining_usd).toBe(200);
  });

  it('zero-amount request returns within_cap=true (status-only)', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 0 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.kyc_url).toBeUndefined(); // gate-off default partner ⇒ no verify handoff
  });

  it('check_send_limit: dormant path returns edd_required:false with all today\'s fields intact', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    const res = await executeTool('check_send_limit', { amount_usd: 200 }, ctx);
    // Today's fields unchanged (regression):
    expect(res).toHaveProperty('within_cap');
    expect(res).toHaveProperty('tier');
    expect(res).toHaveProperty('daily_cap_usd');
    expect(res).toHaveProperty('today_remaining_usd');
    // Additive KYC fields:
    expect(res.edd_required).toBe(false);
    expect(res.edd_threshold_usd).toBe(3000);
  });

  it('check_send_limit: edd_required:true when cumulative-month + requested >= $3k and SoF/occupation absent', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000); // $2,500 this month
    const res = await executeTool('check_send_limit', { amount_usd: 600 }, ctx); // → $3,100
    expect(res.edd_required).toBe(true);
  });

  it('check_send_limit: edd_required:false when the customer already has EDD fields on file (sticky)', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550001111');
    await ctx.customerStore.saveCustomer({
      ...(await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer,
      sourceOfFunds: 'employment', occupation: 'salaried', eddCapturedAt: '2026-05-01T00:00:00Z',
    });
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000);
    const res = await executeTool('check_send_limit', { amount_usd: 600 }, ctx);
    expect(res.edd_required).toBe(false); // sticky profile satisfies it
  });
});

describe('create_transfer — daily volume increment', () => {
  it('increments daily_volume by the transfer amount in cents on success', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15551234567');
    // Verified + outside the 3-day window (T1) so the gate passes and the cap doesn't block
    await ctx.customerStore.saveCustomer({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      partnerId: 'default',
    });
    await executeTool('create_transfer', {
      amount_usd: 100,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'bank_transfer',
    }, ctx);
    expect(await ctx.dailyVolumeStore.getTodayCents('15551234567')).toBe(10_000);
  });
});

describe('create_transfer — KYC EDD / Travel-Rule plumbing', () => {
  // Phase 3: a SENDABLE customer (verified) outside the 3-day window so the
  // verify-before-send gate passes and the cap (T1) doesn't block these
  // EDD/Travel-Rule plumbing assertions.
  async function grandfathered(ctx: Awaited<ReturnType<typeof buildCtx>>) {
    await ctx.customerStore.saveCustomer({
      senderPhone: ctx.phone,
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      partnerId: 'default',
    });
  }

  it('EDD enum args persist onto the Customer (sticky)', async () => {
    const ctx = await buildCtx(fakeRedis(), '15551234567');
    await grandfathered(ctx);
    await executeTool('create_transfer', {
      amount_usd: 100,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'bank_transfer',
      source_of_funds: 'employment',
      occupation: 'salaried',
    }, ctx);
    const customer = await ctx.customerStore.getCustomer(ctx.phone);
    expect(customer?.sourceOfFunds).toBe('employment');
    expect(customer?.occupation).toBe('salaried');
    expect(customer?.eddCapturedAt).toBeTruthy();
  });

  it('invalid enum value is treated as unsupplied (eddFieldsPresent stays false)', async () => {
    const ctx = await buildCtx(fakeRedis(), '15551234567');
    await grandfathered(ctx);
    // $2,500 already this month + $600 → crosses $3k; an invalid SoF must NOT
    // satisfy the EDD requirement, so the transfer must be flagged edd_required.
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000);
    const r = await executeTool('create_transfer', {
      amount_usd: 600,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'bank_transfer',
      source_of_funds: 'lottery_winnings', // not in the closed set → unsupplied
      occupation: 'salaried',
    }, ctx);
    expect(r.compliance_status).toBe('flagged');
    expect(r.compliance_reasons).toContain('edd_required');
    // And nothing invalid leaked onto the Customer.
    const customer = await ctx.customerStore.getCustomer(ctx.phone);
    expect(customer?.sourceOfFunds).toBeUndefined();
    expect(customer?.occupation).toBeUndefined();
  });

  it('Travel-Rule fields flow from the draft into the Transfer', async () => {
    const redis = fakeRedis();
    const base = await buildCtx(redis, '15551234567');
    await grandfathered(base);
    // Seed a draft as if send_approve_picker had been called with Travel-Rule data.
    const draftId = await base.draftStore.createDraft({
      senderPhone: base.phone,
      recipient: {
        name: 'Mom',
        recipientPhone: '919876543210',
        payoutMethod: 'upi',
        payoutDestination: 'mom@upi',
      },
      amountUsd: 100,
      amountSource: 100,
      sourceCurrency: 'USD',
      fundingMethod: 'bank_transfer',
      recipientLegalName: 'Mother Legal Name',
      relationship: 'parent',
      purpose: 'family_support',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 8500 },
    });
    // Approve-tap path: context supplies the draftId.
    const ctx = { ...base, turn: { isNewConversation: false, buttonTap: { kind: 'approve' as const, draftId } } };
    const r = await executeTool('create_transfer', {}, ctx);
    // Travel-Rule fields are encrypted at rest — only the decrypted read returns them.
    const transfer = await ctx.store.getTransferDecrypted(r.transfer_id as string);
    expect(transfer?.recipientLegalName).toBe('Mother Legal Name');
    expect(transfer?.relationship).toBe('parent');
    expect(transfer?.purpose).toBe('family_support');
  });
});

describe('multi-currency dormancy invariant', () => {
  it('get_quote for a multi-currency partner returns source_currency GBP and correct amounts', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15559991111');

    // Seed a multi-currency partner (US + GB)
    const now = new Date().toISOString();
    await ctx.partnerStore.savePartner({
      id: 'multi-test',
      name: 'Multi Partner',
      countries: ['US', 'GB'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Seed customer linked to multi-currency partner
    await ctx.customerStore.saveCustomer({
      senderPhone: '15559991111',
      firstSeenAt: now,
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'multi-test',
      createdAt: now,
      updatedAt: now,
    });

    // Mock getFxRates to return GBP rates for this test
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=GBP')) {
        return { ok: true, json: async () => ({ rates: { INR: 108, USD: 1.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));

    const result = await executeTool(
      'get_quote',
      { amount_usd: 200, funding_method: 'bank_transfer', source_currency: 'GBP' },
      ctx,
    );

    expect(result.source_currency).toBe('GBP');
    expect(result.amount_inr).toBe(21600);  // Math.round(200 * 108)
    expect(result.amount_usd).toBe(254);    // round2(200 * 1.27)
    expect(result.error).toBeUndefined();
  });

  it('get_quote for a single-country (US-only) partner ignores source_currency GBP request (dormant bypass)', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15559992222');

    // Single-country white-label partner — the single-currency bypass must hold:
    // the LLM-supplied source_currency is IGNORED (untrusted) and stays USD.
    const now = new Date().toISOString();
    await ctx.partnerStore.savePartner({
      id: 'us-only-test', name: 'US Only', countries: ['US'], status: 'active', createdAt: now, updatedAt: now,
    });
    await ctx.customerStore.saveCustomer({
      senderPhone: '15559992222', firstSeenAt: now, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'us-only-test', createdAt: now, updatedAt: now,
    });

    const result = await executeTool(
      'get_quote',
      { amount_usd: 200, funding_method: 'bank_transfer', source_currency: 'GBP' },
      ctx,
    );

    expect(result.source_currency).toBe('USD'); // GBP request ignored on a single-currency partner
    expect(result.amount_inr).toBe(Math.round(200 * MOCK_RATE));
    expect(result.error).toBeUndefined();
  });
});

describe('get_quote: receive-first (amount_inr) branch', () => {
  it('amount_inr back-solves the send amount; recipient gets ~the target INR', async () => {
    const ctx = await buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_inr: 42500, funding_method: 'bank_transfer' }, ctx);
    expect('error' in res).toBe(false);
    expect(res.amount_inr).toBeCloseTo(42500, -1); // recipient gets the requested rupees
    expect(res.amount_source).toBeCloseTo(500, 2); // back-solved 42500/85
    // result-key set is unchanged from the send-first path:
    for (const k of ['source_currency', 'amount_source', 'fee_source', 'total_charge_source',
      'amount_usd', 'fee_usd', 'total_charge_usd', 'fx_rate', 'amount_inr', 'delivery_estimate'])
      expect(k in res).toBe(true);
  });

  it('amount_inr WINS when both amount_inr and amount_usd are given', async () => {
    const ctx = await buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_inr: 42500, amount_usd: 9999, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBeCloseTo(500, 2); // from 42500/85, NOT 9999
  });

  it('send-first path is UNCHANGED when amount_inr is absent', async () => {
    const ctx = await buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500);
    expect(res.amount_inr).toBe(Math.round(500 * 85));
  });

  it('a non-finite / non-positive amount_inr is ignored, falling back to amount_usd', async () => {
    const ctx = await buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_inr: 'abc', amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500); // junk amount_inr did not hijack the quote
  });

  it('the back-solved amount still hits the MIN/MAX guard (QuoteError → error result)', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 85 INR → ~$1; below MIN_USD=10 ⇒ quote() throws QuoteError, surfaced as { error }
    const res = await executeTool('get_quote',
      { amount_inr: 85, funding_method: 'bank_transfer' }, ctx);
    expect('error' in res).toBe(true);
  });

  it('receive-first respects source_currency (GBP rates)', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15559991111');
    const now = new Date().toISOString();
    // Seed a multi-currency partner (US + GB)
    await ctx.partnerStore.savePartner({
      id: 'multi-gbp-test',
      name: 'Multi Partner GBP',
      countries: ['US', 'GB'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    // Seed customer linked to multi-currency partner
    await ctx.customerStore.saveCustomer({
      senderPhone: '15559991111',
      firstSeenAt: now,
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'multi-gbp-test',
      createdAt: now,
      updatedAt: now,
    });
    // Mock GBP rates: 1 GBP = 108 INR, 1 GBP = 1.27 USD
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=GBP')) {
        return { ok: true, json: async () => ({ rates: { INR: 108, USD: 1.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const res = await executeTool('get_quote',
      { amount_inr: 21600, funding_method: 'bank_transfer', source_currency: 'GBP' }, ctx);
    expect(res.source_currency).toBe('GBP');
    expect(res.amount_source).toBeCloseTo(200, 2); // 21600 / 108
  });
});

describe('send_approve_picker — cap enforcement', () => {
  it('refuses to send buttons and returns error when over cap', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550002222');
    await ctx.customerStore.upsertOnFirstInbound('15550002222');
    // Prime the rate cache with the standard stub BEFORE replacing fetch, so
    // resolveCurrencyAndRates doesn't hit the WhatsApp-detection stub.
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    let interactiveSent = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      interactiveSent = true;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 700, // over T0 $500 per-transfer cap
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(r.error).toBeDefined();
    expect(interactiveSent).toBe(false); // never reached sendInteractive
  });
});

