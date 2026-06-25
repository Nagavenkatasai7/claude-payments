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
  it('exposes all twenty-one tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_draft',
      'cancel_schedule',
      'capture_corridor_request',
      'check_payment_status',
      'check_send_limit',
      'create_schedule',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
      'list_recent_transfers',
      'list_saved_recipients',
      'list_schedules',
      'open_recall_dispute',
      'present_bill',
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

describe('send_approve_picker — one-tap CTA pay (Batch 1)', () => {
  // Helper: build a context with a cleared recipient + primed rate cache
  async function buildClearedCtx() {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550003333');
    await ctx.customerStore.upsertOnFirstInbound('15550003333');
    // Prime rate cache before we replace fetch
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    return ctx;
  }

  it('CLEARED recipient → { sent:true, draft_id }; POST body has cta_url type and https pay URL', async () => {
    const ctx = await buildClearedCtx();
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // Find the WhatsApp API call (cta_url)
    const waCall = calls.find((c) => (c.body as Record<string, unknown>)?.interactive);
    expect(waCall).toBeDefined();
    const interactive = (waCall!.body as Record<string, unknown>).interactive as Record<string, unknown>;
    expect(interactive.type).toBe('cta_url');
    const params = (interactive.action as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params.url).toMatch(/\/pay\/.+$/);
    expect(String(params.url)).toMatch(/^https:\/\//);
  });

  it('does NOT re-send the approve card on a duplicate call (at-least-once retry / double tool-call)', async () => {
    const ctx = await buildClearedCtx();
    let ctaSends = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse((init.body as string) ?? 'null') : null;
      if ((body?.interactive as Record<string, unknown>)?.type === 'cta_url') ctaSends++;
      return { ok: true, text: async () => '' };
    }));
    const args = {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    };
    const first = await executeTool('send_approve_picker', args, ctx);
    const second = await executeTool('send_approve_picker', args, ctx); // the retry re-runs the turn
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(true);   // still reports sent so the agent suppresses trailing text (no dup text either)
    expect(ctaSends).toBe(1);         // the "Approve & Pay" card was sent EXACTLY once
  });

  it('releases the idempotency key when the card SEND fails, so the retry re-delivers', async () => {
    const ctx = await buildClearedCtx();
    let ctaAttempts = 0;
    let failNext = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse((init.body as string) ?? 'null') : null;
      if ((body?.interactive as Record<string, unknown>)?.type === 'cta_url') {
        ctaAttempts++;
        // Reject (network-level) only on the FIRST card send — sendCtaUrl rethrows
        // (no res ⇒ no graceful sendText fallback), so the tool rethrows.
        if (failNext) { failNext = false; throw new Error('network reset'); }
      }
      return { ok: true, text: async () => '' };
    }));
    const args = {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    };
    // First attempt: the send throws → the turn fails (and would be retried).
    await expect(executeTool('send_approve_picker', args, ctx)).rejects.toThrow(/network reset/);
    // Retry: the failed send RELEASED the key, so the card actually goes out now
    // (a stuck key would have suppressed it → customer gets NO link).
    const retry = await executeTool('send_approve_picker', args, ctx);
    expect(retry.sent).toBe(true);
    expect(ctaAttempts).toBe(2);      // attempted on the failed send AND the successful retry
  });

  it('cold-start (no payout details) → draft with empty payoutDestination, placeholder on the card', async () => {
    const ctx = await buildClearedCtx();
    let ctaText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const cta = (body?.interactive as Record<string, unknown>)?.body as Record<string, unknown> | undefined;
      if (cta && typeof cta.text === 'string') ctaText = cta.text;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      // NO payout_method / payout_destination — collected on the secure page
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // Draft stores an EMPTY destination (filled at pay time from the POST body)
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(draft!.recipient.payoutDestination).toBe('');
    expect(draft!.recipient.payoutMethod).toBe('bank');
    // The approve card shows the placeholder, not "bank a/c on file"
    expect(ctaText).toContain("you'll enter the details on the secure page");
  });

  it('the draft is persisted with the enriched quote (totalChargeUsd is a number)', async () => {
    const ctx = await buildClearedCtx();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(typeof r.draft_id).toBe('string');
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(typeof draft!.quote.totalChargeUsd).toBe('number');
  });

  it('BLOCKED recipient (John Doe) → { blocked }, no draft/CTA, persists an audit row', async () => {
    const ctx = await buildClearedCtx();
    let ctaFetched = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      ctaFetched = true;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'John Doe', // on the test watchlist → blocked
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'john@upi',
    }, ctx);
    // New contract: a compliance block returns { blocked, reply_to_customer },
    // never an { error } the model would paraphrase as a technical glitch.
    expect(r.blocked).toBe(true);
    expect(typeof r.reply_to_customer).toBe('string');
    expect(String(r.reply_to_customer).toLowerCase()).not.toContain('went wrong');
    expect(r.sent).toBeUndefined();
    expect(r.draft_id).toBeUndefined();
    expect(ctaFetched).toBe(false);
    // The blocked attempt is now persisted as an auditable ledger row.
    const blocked = (await ctx.store.listTransfers()).filter((t) => t.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].recipientName).toBe('John Doe');
  });
});

describe('cancel_draft — typed cancel via active-draft pointer (Batch 1)', () => {
  it('cancels the active draft when there is no Cancel-button tap', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550004444');
    await ctx.customerStore.upsertOnFirstInbound('15550004444');
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx); // prime rates
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const picker = await executeTool('send_approve_picker', {
      amount_usd: 150, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    }, ctx);
    expect(picker.sent).toBe(true);
    // typed 'cancel' → no buttonTap; cancelDraftTool falls back to the active-draft pointer
    const r = await executeTool('cancel_draft', {}, ctx);
    expect(r.cancelled).toBe(true);
    const again = await executeTool('cancel_draft', {}, ctx); // pointer cleared on consume
    expect(again.cancelled).toBe(false);
  });

  it('returns cancelled:false / no_active_draft when nothing is pending', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550005555');
    const r = await executeTool('cancel_draft', {}, ctx);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('no_active_draft');
  });
});

const baseQuote = (over: Partial<Quote> = {}): Quote => ({
  amountUsd: 500, feeUsd: 1.99, totalChargeUsd: 501.99, fxRate: 83, amountInr: 41500,
  deliveryEstimate: 'within 10 minutes', sourceCurrency: 'USD', amountSource: 500,
  feeSource: 1.99, totalChargeSource: 501.99, ...over,
});

describe('buildApproveSummary — enriched single approve body (A1/A2)', () => {
  it('renders FX rate, ETA, masked bank destination, and the rate-lock line', () => {
    // IN format stores the account LAST (composePayoutDestination order), so the
    // account tail is what surfaces.
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('1 USD = ₹83');
    expect(s).toContain('₹41,500');
    expect(s).toContain('within 10 minutes');
    expect(s).toContain('bank a/c ****6789');
    // The card now shows ONLY the last 4 — no IFSC/routing code, no IBAN body —
    // so it is leak-proof in every country format.
    expect(s).not.toContain('HDFC0001234');
    expect(s).toContain('Rate locked ~10 min');
  });
  it('masks the account even when fields arrive reversed (ifsc before acct) — never leaks the full number', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('bank a/c ****6789');
    expect(s).not.toContain('HDFC0001234');     // bank code is dropped entirely
    expect(s).not.toContain('123456789');       // the full account number must not appear
  });
  it('never leaks an AE IBAN (the previous heuristic showed it whole)', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'AE070331234567890123456', 'bank_transfer');
    expect(s).toContain('bank a/c ****3456');
    expect(s).not.toContain('AE070331234567890123456');
    expect(s).not.toContain('33123456789'); // no run of the IBAN body survives
  });
  it('never leaks a US account when routing and account are similar lengths', () => {
    // routing first, account second — both 9 digits; the account must not leak
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '021000021 123456789', 'bank_transfer');
    expect(s).toMatch(/bank a\/c \*\*\*\*\d{4}/);
    expect(s).not.toContain('123456789'); // full account never shown
    expect(s).not.toContain('021000021'); // full routing never shown either
  });
  it('never leaks a hyphenated NZ account number', () => {
    // NZ account is one hyphenated field (bank-branch-account-suffix). Under the
    // account-last rule the tail is the trailing run (the suffix) — still ≤4
    // digits, and the account body never appears, so it stays leak-proof.
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '01-0123-0123456-00', 'bank_transfer');
    expect(s).toMatch(/bank a\/c \*\*\*\*\d{1,4}/);
    expect(s).not.toContain('0123456');        // the account body must not appear
  });
  it('shows a UPI destination in full', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('UPI mom@okhdfc');
  });
  it('first transfer (feeUsd 0) → "first transfer free" framing, NEVER "Fee $0.00"', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 0, feeSource: 0 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s.toLowerCase()).toContain('first transfer free');
    expect(s).not.toContain('Fee $0.00');
  });
  it('a repeat transfer renders a concrete Fee line', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 1.99, feeSource: 1.99 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('Fee $1.99');
  });
  it('a GBP-source quote renders "1 GBP = ₹"', () => {
    const s = buildApproveSummary(baseQuote({ sourceCurrency: 'GBP', amountSource: 400, feeSource: 1.6 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('1 GBP = ₹');
    expect(s).toContain('£');
  });

  // Item 2: bank details collected on the secure pay page, not in chat. On a
  // cold-start draft there is no payout destination yet — the card shows a
  // placeholder instead of "bank a/c on file".
  it('empty payoutDestination → placeholder "their bank account (you\'ll enter the details on the secure page)"', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '', 'bank_transfer');
    expect(s).toContain("their bank account (you'll enter the details on the secure page)");
    expect(s).not.toContain('bank a/c on file');
    expect(s).not.toContain('****');
  });

  it('non-empty payoutDestination keeps the masked "bank a/c ****<last4>" line', () => {
    // account composed LAST (IN order) → its tail is shown
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('bank a/c ****6789');
    expect(s).not.toContain('their bank account (you');
  });
});

describe('validate_phone — read-only phone early-catch', () => {
  const call = (phone: unknown) =>
    executeTool('validate_phone', { phone }, {} as never); // ctx is never touched

  it('a clean 919876543210 → valid, normalized, + detected destination IN', async () => {
    expect(await call('919876543210')).toEqual({ valid: true, normalized: '919876543210', detected_destination_country: 'IN' });
  });
  it('a formatted "+91 98765 43210" → valid, normalized digits-only, detected IN', async () => {
    expect(await call('+91 98765 43210')).toEqual({ valid: true, normalized: '919876543210', detected_destination_country: 'IN' });
  });
  it('too-short "12345" → valid:false with a re-ask error', async () => {
    const r = await call('12345') as { valid: boolean; error: string };
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/valid/i);
  });
  it('junk/empty → valid:false', async () => {
    expect((await call('') as { valid: boolean }).valid).toBe(false);
    expect((await call('abc') as { valid: boolean }).valid).toBe(false);
  });
  it('performs no Redis I/O — runs with a bare ctx and still returns', async () => {
    // {} as never proves the handler reads nothing off ctx
    expect((await call('919876543210') as { valid: boolean }).valid).toBe(true);
  });
});

describe('resolve_recipient — typed-name lookup of saved recipients', () => {
  const seedRecipient = async (
    ctx: Awaited<ReturnType<typeof buildCtx>>,
    over: Partial<{ name: string; recipientPhone: string; payoutMethod: 'upi' | 'bank'; payoutDestination: string }> = {},
  ) => {
    await ctx.store.upsertRecipient(ctx.phone, {
      name: over.name ?? 'Mom',
      recipientPhone: over.recipientPhone ?? '919876543210',
      payoutMethod: over.payoutMethod ?? 'upi',
      payoutDestination: over.payoutDestination ?? 'mom@okhdfc',
      lastUsedAt: new Date().toISOString(),
    });
  };

  it('returns match:exact for a single case-insensitive, trimmed name match with payout details', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210', payoutDestination: 'mom@okhdfc' });
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111', payoutDestination: 'dad@okaxis' });
    const r = await executeTool('resolve_recipient', { name: '  mOm ' }, ctx);
    expect(r.match).toBe('exact');
    expect((r.recipient as Record<string, unknown>).recipient_phone).toBe('919876543210');
    expect((r.recipient as Record<string, unknown>).payout_destination).toBe('mom@okhdfc');
    // field hygiene: no internal fields leak
    expect(r.recipient).not.toHaveProperty('partnerId');
    expect(r.recipient).not.toHaveProperty('complianceStatus');
  });

  it('returns match:ambiguous when two saved recipients share the name', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210' });
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919800000000' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(2);
  });

  it('returns match:ambiguous for a partial/substring match (never auto-proceeds)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom (work)', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(1);
  });

  it('returns match:none when nothing matches (cold-start path)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none');
  });

  it('only searches the calling sender\'s own recipients', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15551234567');
    const otherCtx = await buildCtx(redis, '15559999999');
    await seedRecipient(otherCtx, { name: 'Mom', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none'); // the other sender's recipient is invisible
  });
});

describe('maskAccount — exported helper', () => {
  it('UPI: returns the address unchanged', () => {
    expect(maskAccount('upi', 'mom@okhdfc')).toBe('mom@okhdfc');
  });

  it('bank: collapses to ****<last4> of the account (the LAST composed field)', () => {
    // composePayoutDestination stores the account LAST, so its tail is shown;
    // nothing else (routing/IFSC) surfaces.
    expect(maskAccount('bank', 'HDFC0001234 123456789')).toBe('****6789');
  });

  it('bank: the trailing account run is what surfaces, not a leading code', () => {
    // SBIN0001234 then the account → account tail wins
    expect(maskAccount('bank', 'SBIN0001234 987654321')).toBe('****4321');
  });

  it('bank: never includes the raw account number, even with no spaces (IBAN)', () => {
    const result = maskAccount('bank', 'AE070331234567890123456');
    expect(result).not.toContain('AE070331234567890123456');
    expect(result).toBe('****3456');
  });
});

describe('list_saved_recipients — payout_destination masking (Fix #1)', () => {
  it('bank recipient: full account number does NOT appear; last 4 do', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: 'HDFC0001234 123456789', // account composed LAST
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('list_saved_recipients', {}, ctx);
    const rec = (r.recipients as Record<string, unknown>[])[0];
    expect(String(rec.payout_destination)).not.toContain('123456789');
    expect(String(rec.payout_destination)).toContain('6789');
  });

  it('UPI recipient: payout_destination returned unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Dad',
      recipientPhone: '919811111111',
      payoutMethod: 'upi',
      payoutDestination: 'dad@okaxis',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('list_saved_recipients', {}, ctx);
    const rec = (r.recipients as Record<string, unknown>[])[0];
    expect(rec.payout_destination).toBe('dad@okaxis');
  });
});

describe('resolve_recipient — payout_destination masking (Fix #1)', () => {
  it('bank recipient: full account does NOT appear in exact match result', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Priya',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: 'SBIN0001234 987654321', // account composed LAST
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Priya' }, ctx);
    expect(r.match).toBe('exact');
    const dest = String((r.recipient as Record<string, unknown>).payout_destination);
    expect(dest).not.toContain('987654321');
    expect(dest).toContain('4321');
  });

  it('bank recipient: full account does NOT appear in ambiguous candidates', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: '111222333444 HDFC0001234',
      lastUsedAt: new Date().toISOString(),
    });
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919800000000',
      payoutMethod: 'bank',
      payoutDestination: '555666777888 ICIC0001234',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    for (const c of r.candidates as Record<string, unknown>[]) {
      expect(String(c.payout_destination)).not.toContain('111222333444');
      expect(String(c.payout_destination)).not.toContain('555666777888');
    }
  });

  it('UPI exact match: payout_destination stays unmasked', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Ravi',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'ravi@okhdfc',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Ravi' }, ctx);
    expect(r.match).toBe('exact');
    expect((r.recipient as Record<string, unknown>).payout_destination).toBe('ravi@okhdfc');
  });
});

describe('get_quote cap guard (Bundle D)', () => {
  it('refuses an over-per-transfer amount with a cap result (no quote)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 700, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.fee_usd).toBeUndefined();        // NO quote presented
    expect(r.amount_inr).toBeUndefined();
    expect(r.kyc_url).toBeUndefined();        // gate-off partner ⇒ no verify handoff
    expect(r.per_transfer_cap_usd).toBe(500);
  });

  it('refuses an over-daily amount and reports the remaining', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.dailyVolumeStore.addCents(PHONE, 40_000); // $400 already used today
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_remaining_usd).toBe(100); // $500 cap − $400 used
    expect(r.fee_usd).toBeUndefined();
  });

  it('guards the receive-first (amount_inr) path too', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 70000 INR / 85 ≈ $823 USD-equiv → over the $500 per-transfer cap
    const r = await executeTool('get_quote', { amount_inr: 70000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.fee_usd).toBeUndefined();
  });

  it('still returns a normal quote when within cap (no within_cap field)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 300, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBeUndefined();     // success path unchanged
    expect(r.fee_usd).toBe(0);                // first transfer free
    expect(r.amount_inr).toBe(Math.round(300 * MOCK_RATE));
  });
});

describe('create_transfer records the sender\'s funding method (Bundle C)', () => {
  it('writes lastFundingMethod onto the customer after a successful create', async () => {
    const ctx = await buildCtx(fakeRedis());
    await executeTool('create_transfer', {
      amount_usd: 200,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'credit_card',
    }, ctx);
    const c = await ctx.customerStore.getCustomer(ctx.phone);
    expect(c?.lastFundingMethod).toBe('credit_card');
  });
});

describe('repeat_transfer — reactive re-send to a past recipient (Bundle C)', () => {
  const seedPastTransfer = async (ctx: Awaited<ReturnType<typeof buildCtx>>) => {
    // A real create so the recipient + a past transfer exist with full details.
    // $200 (not $500) so a repeat stays within the T0 $500/day cap and exercises
    // the REAL cap gate inside repeat_transfer rather than tripping it.
    await executeTool('create_transfer', {
      amount_usd: 200,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@okhdfc',
      funding_method: 'bank_transfer',
    }, ctx);
  };

  it('hydrates the last transfer and sends an approve card (a draft, NOT a new transfer)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const countBefore = await ctx.store.getTransferCount(ctx.phone);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // routed through the draft path — no new transfer created yet
    expect(await ctx.store.getTransferCount(ctx.phone)).toBe(countBefore);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    // Repeats must carry the REAL account into the new draft — hydrated from the
    // saved recipient (decrypted), never the masked default ledger read.
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(200); // reused last amount
  });

  it('honors an amount_usd override', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 250 }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.amountSource).toBe(250);
  });

  it('falls back to the sender\'s remembered funding method when none is given', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx); // last transfer used bank_transfer + records it as the default
    await ctx.customerStore.recordFundingMethod(ctx.phone, 'credit_card'); // newer default
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.fundingMethod).toBe('credit_card');
  });

  it('errors when there is no past transfer to that number', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('repeat_transfer', { recipient_phone: '910000000000' }, ctx);
    expect(r.error).toBeDefined();
    expect(r.sent).toBeUndefined();
  });

  it('returns needs_edd (and does NOT send a card) when the month is over the EDD threshold', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    // push cumulative monthly volume over $3,000 so evaluateEdd trips; customer has no SoF/occupation
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 300000);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.payout_destination).toBe('mom@okhdfc'); // REAL destination for the follow-up card
  });
});

describe('any-to-any corridors — destination_country threading', () => {
  // AED fallback rate: 1 USD = 1/0.27 ≈ 3.703 AED (from FALLBACK_FX_RATES.AED.toUsd = 0.27).
  // USD→AED cross rate = USD.toUsd / AED.toUsd = 1 / 0.27 ≈ 3.703.
  // For $500 USD: amountInr (= AED dest) = Math.round(500 * (1/0.27)) = Math.round(500 * 3.7037) = 1852.
  // Note: getFxRates('AED') for INR destination will return FALLBACK; for source USD it's already cached.

  function stubAedFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        // AED rates: toInr=23.1, toUsd=0.27
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      // USD rates: toInr=85 (standard mock)
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
  }

  it('get_quote with destination_country AE returns destination_currency AED and amount_dest in AED (≠ INR amount)', async () => {
    resetRateCacheForTests();
    stubAedFetch();
    const ctx = await buildCtx(fakeRedis());
    // Prime USD rates first (avoids AED mock intercepting a USD call)
    const r = await executeTool('get_quote', {
      amount_usd: 500,
      funding_method: 'bank_transfer',
      destination_country: 'AE',
    }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.destination_currency).toBe('AED');
    expect(r.destination_country).toBe('AE');
    // amount_dest == amount_inr (same value, clearer alias for non-India)
    expect(r.amount_dest).toBe(r.amount_inr);
    // AED amount should NOT equal the INR amount for the same $500 send
    // INR: Math.round(500 * 85) = 42500; AED: Math.round(500 / 0.27) ≈ 1852
    expect(r.amount_inr).toBeLessThan(10000); // AED is much smaller than INR
    expect(r.amount_inr).toBeGreaterThan(0);
    // The rate is the cross-rate USD→AED ≈ 3.7
    expect((r.fx_rate as number)).toBeCloseTo(1 / 0.27, 1);
  });

  it('get_quote with NO destination_country defaults to India (INR, back-compat)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', {
      amount_usd: 500,
      funding_method: 'bank_transfer',
    }, ctx);
    expect(r.destination_currency).toBe('INR');
    expect(r.destination_country).toBe('IN');
    expect(r.amount_inr).toBe(Math.round(500 * MOCK_RATE));
  });

  it('send_approve_picker to AE creates a draft with destinationCurrency AED in the quote', async () => {
    resetRateCacheForTests();
    stubAedFetch();
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550099999');
    await ctx.customerStore.upsertOnFirstInbound('15550099999');
    // Prime the rate cache for USD first
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      // WhatsApp API or USD
      if (u.includes('graph.facebook.com') || u.includes('whatsapp')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Ali',
      recipient_phone: '971501234567',
      payout_method: 'bank',
      payout_destination: 'AE12 0000 0000 0000 1234 567',
      destination_country: 'AE',
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(draft!.destinationCurrency).toBe('AED');
    expect(draft!.destinationCountry).toBe('AE');
    expect(draft!.quote.destinationCurrency).toBe('AED');
  });

  it('buildApproveSummary with AED destination formats rate and dest amount in AED (not ₹)', () => {
    const q = baseQuote({
      fxRate: 3.7,      // USD→AED cross rate
      amountInr: 1850,  // AED dest amount (field name kept for back-compat)
      destinationCurrency: 'AED',
    });
    const s = buildApproveSummary(q, 'Ali', 'bank', 'AE12 0000 0000 0000 1234 567', 'bank_transfer', 'AED');
    // Should show AED, not INR (₹)
    expect(s).toContain('AED');
    expect(s).not.toContain('₹');
    expect(s).toContain('1 USD = AED');
  });
});

describe('Phase 3 verify-before-send gate (bot tools)', () => {
  const UNVERIFIED = '15557770000';

  // Seed an unverified (grandfathered) customer under a partner that has
  // OPTED IN to verify-before-send (the gate is partner-configured now —
  // an unconfigured partner never gates).
  async function seedUnverified(ctx: Awaited<ReturnType<typeof buildCtx>>) {
    const nowIso = new Date().toISOString();
    const dflt = await ctx.partnerStore.ensureDefaultPartner();
    await ctx.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: nowIso });
    await ctx.customerStore.saveCustomer({
      senderPhone: ctx.phone, firstSeenAt: nowIso, kycStatus: 'grandfathered',
      senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
  }

  it('check_send_limit returns within_cap:false + reason kyc_required + a kyc_url; no cap fields needed', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('check_send_limit', { amount_usd: 100 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
  });

  it('get_quote returns within_cap:false + kyc_url and does NOT produce a quote', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
    expect(r.amount_inr).toBeUndefined(); // no quote built
  });

  it('create_transfer (legacy path) returns kyc_required and creates NO transfer', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('create_transfer', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    expect(r.kyc_required).toBe(true);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('send_approve_picker returns kyc_required and creates NO draft', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('send_approve_picker', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    expect(r.kyc_required).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.draft_id).toBeUndefined();
  });
});

describe('KYC gate OFF — cap refusals never surface verification (QA audit fix)', () => {
  // The default seeded partner has requireKycBeforeSend unset ⇒ gate OFF.
  // A T0 customer over their cap must get the plain cap refusal: no kyc_url,
  // and — critically — NO kycProvider.startVerification side effect (it creates
  // a real Persona inquiry in production).

  it('check_send_limit over-cap: refusal fields intact, no kyc_url, no startVerification', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('check_send_limit', { amount_usd: 5000 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.tier).toBe('T0');
    expect(r.daily_cap_usd).toBe(500);
    expect(r.today_remaining_usd).toBe(500);
    expect(r.kyc_url).toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('get_quote over-cap: refusal fields intact, no kyc_url, no startVerification', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('get_quote', { amount_usd: 5000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.tier).toBe('T0');
    expect(r.kyc_url).toBeUndefined();
    expect(r.amount_inr).toBeUndefined(); // still no quote built
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('gate ON: the same T0 over-cap refusal still hands off a kyc_url', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const nowIso = new Date().toISOString();
    const dflt = await ctx.partnerStore.ensureDefaultPartner();
    await ctx.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: nowIso });
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('check_send_limit', { amount_usd: 5000 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(typeof r.kyc_url).toBe('string');
    expect(startSpy).toHaveBeenCalled();
  });
});

describe('best-rate routing (B2) — quote → draft → mint', () => {
  // Stub integrations + routable-rail shape, mirroring tests/partner-rates.test.ts.
  const ROUTABLE = {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.test/x', signingSecret: 's' },
  };
  function stubIntegrations(byPartner: Record<string, PartnerIntegrations['payment']>): PartnerIntegrationsStore {
    return {
      getIntegrations: async (partnerId: string) => ({
        kyc: {}, whatsapp: {}, payment: byPartner[partnerId] ?? {},
      }),
    } as unknown as PartnerIntegrationsStore;
  }
  // The REAL selection service over the test PGlite, shaped as ToolContext.routeSelector.
  function realSelector(byPartner: Record<string, PartnerIntegrations['payment']>) {
    return (s: CurrencyCode, d: CurrencyCode, m: number) =>
      selectSettlementRoute(db, stubIntegrations(byPartner), s, d, m);
  }
  // A canned winning route (unit seam) — id chosen so no random transfer id can contain it.
  const WIN = { fxRate: 86, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' };

  const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it('get_quote (default tenant): the REAL selector wins the corridor — fxRate + amountInr override, fees/USD-equivalent unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPartner(db, 'rail-partner-x');
    await createPartnerRateRepo(db).upsertRate({
      id: 'r1', partnerId: 'rail-partner-x', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: inOneHour(),
    });
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: realSelector({ 'rail-partner-x': ROUTABLE }) },
    );
    expect(r.fx_rate).toBe(86);                       // the winning rate, not mid (85)
    expect(r.amount_inr).toBe(Math.round(400 * 86));  // 34,400 — quote()'s exact rounding
    expect(r.amount_dest).toBe(r.amount_inr);
    expect(r.fee_usd).toBe(0);                        // fees are rate-independent
    expect(r.amount_usd).toBe(400);                   // USD-equivalent (caps) unchanged
    // Customer invisibility: the routing partner never appears in the result.
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });

  it('get_quote: a platform route (no winner) leaves the result byte-identical to the no-selector quote', async () => {
    const ctx = await buildCtx(fakeRedis());
    const baseline = await executeTool('get_quote', { amount_usd: 400, funding_method: 'bank_transfer' }, ctx);
    const routed = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async (_s, _d, m) => ({ fxRate: m, source: 'platform' as const }) },
    );
    expect(routed).toEqual(baseline);
  });

  it('get_quote: the selector receives the mid cross-rate; a throwing selector fail-opens to mid (never a blocker)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const spy = vi.fn(async () => { throw new Error('rates outage'); });
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: spy },
    );
    expect(spy).toHaveBeenCalledWith('USD', 'INR', MOCK_RATE); // mid in, fail-open out
    expect(r.error).toBeUndefined();
    expect(r.fx_rate).toBe(MOCK_RATE);
    expect(r.amount_inr).toBe(Math.round(400 * MOCK_RATE));
  });

  it('get_quote receive-first (amount_inr): back-solves with the WINNING rate so the recipient gets the exact target', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 34,400 / 86 = 400 exactly; at mid (85) the back-solve would be 404.71.
    const r = await executeTool(
      'get_quote',
      { amount_inr: 34_400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => WIN },
    );
    expect(r.fx_rate).toBe(86);
    expect(r.amount_source).toBe(400);     // winning-rate back-solve, NOT 404.71
    expect(r.amount_inr).toBe(34_400);     // the exact target lands
    expect(r.fee_usd).toBe(0);
  });

  it('receive-first: a winning back-solve that dips under MIN_USD falls back to the mid quote (never a blocker)', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 855/85 = $10.06 (≥ MIN_USD) at mid, but 855/86 = $9.94 (< MIN_USD) at
    // the winning rate — the better rate must NOT turn a valid quote into a refusal.
    const r = await executeTool(
      'get_quote',
      { amount_inr: 855, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => WIN },
    );
    expect(r.error).toBeUndefined();
    expect(r.fx_rate).toBe(MOCK_RATE);            // mid quote preserved
    expect(r.amount_source).toBeCloseTo(10.06, 2);
  });

  it('receive-first on a non-INR corridor back-solves via the cross-rate (recipient gets the target DEST amount, not rupees)', async () => {
    // any-to-any fix: amount_inr=1000 with an AE destination means AED 1000 the
    // RECIPIENT receives (the destination currency), NOT ₹1000. sourceForDest
    // back-solves via the USD-pivot cross-rate (USD→AED ≈ 3.7037), so the mid
    // send ≈ $270 and the recipient gets exactly AED 1000. A better route (3.8)
    // yields a SMALLER send (≈ $263.16 ≤ the cap-checked $270), so it applies.
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_inr: 1000, funding_method: 'bank_transfer', destination_country: 'AE' },
      { ...ctx, routeSelector: async () => ({ fxRate: 3.8, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }) },
    );
    expect(r.error).toBeUndefined();
    expect(r.destination_currency).toBe('AED');
    expect(r.amount_inr as number).toBeCloseTo(1000, 0);   // recipient gets AED 1000 (NOT ₹1000)
    expect(r.fx_rate as number).toBeCloseTo(3.8, 4);       // the better route applies (smaller send)
    expect(r.amount_source as number).toBeCloseTo(263.16, 1); // 1000/3.8, NOT ~11.76 (the old ÷toInr bug)
  });

  it('a worse-than-mid "partner" route is rejected at the seam — the customer never quotes below mid', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => ({ fxRate: 84, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }) },
    );
    expect(r.fx_rate).toBe(MOCK_RATE);
    expect(r.amount_inr).toBe(Math.round(400 * MOCK_RATE));
  });

  it('a "partner" route missing settlementPartnerId is rejected — a partner rate can never pair with a platform settle', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => ({ fxRate: 86, source: 'partner' as const }) },
    );
    expect(r.fx_rate).toBe(MOCK_RATE); // no rail ⇒ no route ⇒ mid
  });

  it('white-label tenant: the selector is NEVER called — the customer is pinned to their partner at mid', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15558887777');
    await seedPartner(db, 'acme');
    const nowIso = new Date().toISOString();
    await ctx.customerStore.saveCustomer({
      senderPhone: '15558887777', firstSeenAt: nowIso, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'acme', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
    const spy = vi.fn(async () => WIN);
    const quoted = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: spy },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(quoted.fx_rate).toBe(MOCK_RATE);

    // send_approve_picker is pinned the same way.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const picker = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer',
      recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi',
    }, { ...ctx, routeSelector: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(picker.sent).toBe(true);
    const draft = await ctx.draftStore.consumeDraft(picker.draft_id as string);
    expect(draft?.quote.fxRate).toBe(MOCK_RATE);
    expect(draft?.settlementPartnerId).toBeUndefined();
  });

  it('send_approve_picker stores the winning route on the draft; the card shows ONLY the better rate', async () => {
    const redis = fakeRedis();
    const ctx0 = await buildCtx(redis, '15550007777');
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx0); // prime FX cache
    let ctaText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const cta = (body?.interactive as Record<string, unknown>)?.body as Record<string, unknown> | undefined;
      if (cta && typeof cta.text === 'string') ctaText = cta.text;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer',
      recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi',
    }, { ...ctx0, routeSelector: async () => WIN });
    expect(r.sent).toBe(true);
    // The draft carries the route — rate-dependent quote fields + the rail partner.
    const draft = await ctx0.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.settlementPartnerId).toBe('rail-partner-x');
    expect(draft?.quote.fxRate).toBe(86);
    expect(draft?.quote.amountInr).toBe(Math.round(200 * 86)); // 17,200
    expect(draft?.amountUsd).toBe(200); // USD-equivalent for caps — rate-independent
    // The customer sees only the better rate; never the routing partner.
    expect(ctaText).toContain('₹86');
    expect(ctaText).toContain('₹17,200');
    expect(ctaText).not.toContain('rail-partner-x');
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });

  it('approve-tap mint: the draft route + draft quote mint VERBATIM (settlementPartnerId + winning fxRate)', async () => {
    const redis = fakeRedis();
    const base = await buildCtx(redis, '15550008888');
    await seedPartner(db, 'rail-partner-x');
    const draftId = await base.draftStore.createDraft({
      senderPhone: base.phone,
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200,
      amountSource: 200,
      sourceCurrency: 'USD',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 86, amountInr: 17_200, feeSource: 0, totalChargeSource: 200, totalChargeUsd: 200 },
      settlementPartnerId: 'rail-partner-x',
    });
    const ctx = { ...base, turn: { isNewConversation: false, buttonTap: { kind: 'approve' as const, draftId } } };
    const r = await executeTool('create_transfer', {}, ctx);
    expect(r.error).toBeUndefined();
    const t = await ctx.store.getTransfer(r.transfer_id as string);
    expect(t?.settlementPartnerId).toBe('rail-partner-x'); // the winning rail
    expect(t?.fxRate).toBe(86);                            // the draft's (winning) rate, not a re-quote at 85
    expect(t?.amountInr).toBe(17_200);
    expect(t?.feeUsd).toBe(0);
    expect(t?.partnerId).toBe('default');                  // ownership unchanged
    // Tool result (fed to the LLM) leaks nothing about the routing partner.
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });
});

describe('request_refund (customer-facing refund request — suggest-only, ops approves)', () => {
  type Ctx = Awaited<ReturnType<typeof buildCtx>>;

  // Mint an awaiting_payment transfer owned by ctx.phone via the real tool path.
  async function mintTransfer(ctx: Ctx): Promise<string> {
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
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  async function mintPaid(ctx: Ctx): Promise<string> {
    const id = await mintTransfer(ctx);
    expect(await ctx.store.updateTransferFromWebhook(id, 'paid')).not.toBeNull();
    return id;
  }

  // Force a status the webhook machine can't reach (cancelled/blocked/in_review).
  async function forceStatus(ctx: Ctx, id: string, status: 'cancelled' | 'blocked' | 'in_review') {
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({ ...t, status });
  }

  // The tool's entire customer-safe surface: ONLY these keys may ever leave it,
  // and no internal token may ride along in any value.
  function expectCustomerSafe(result: Record<string, unknown>) {
    // transfer_id is the customer's OWN id (no PII) — safe to surface so the bot
    // can name the specific transfer. opened/case_id belong to open_recall_dispute.
    const allowed = new Set([
      'error', 'error_code', 'message', 'requested', 'reply_hint',
      'transfer_id', 'opened', 'case_id',
    ]);
    for (const k of Object.keys(result)) {
      expect(allowed.has(k), `unexpected key leaked from request_refund: ${k}`).toBe(true);
    }
    const json = JSON.stringify(result).toLowerCase();
    expect(json).not.toContain('settlementpartner');
    expect(json).not.toContain('compliance');
    expect(json).not.toContain('refundstatus');
  }

  it('STRICT ownership: an unknown transfer id reads as not found', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_refund', { transfer_id: 'tr_nope' }, ctx);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expectCustomerSafe(r);
  });

  it("STRICT ownership: another customer's PAID transfer is indistinguishable from a missing one (404-never-403)", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintPaid(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('request_refund', { transfer_id: id }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expectCustomerSafe(r);
    // And the ledger was not touched.
    expect((await owner.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('awaiting_payment: nothing to refund — just do not pay / cancel; no flag is set', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('not_paid_yet');
    expect(String(r.message).toLowerCase()).toContain('cancel');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('delivered within 24h ⇒ use_recall (route to open_recall_dispute), never a refund flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    // updateTransferFromWebhook stamps deliveredAt = now() ⇒ inside the 24h window.
    await ctx.store.updateTransferFromWebhook(id, 'delivered');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('use_recall');
    expect(r.transfer_id).toBe(id);
    expect(String(r.reply_hint).toLowerCase()).toContain('recall');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('delivered over 24h ago ⇒ recall_window_passed, never a refund flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await ctx.store.updateTransferFromWebhook(id, 'delivered');
    // Backdate deliveredAt past the 24h recall window.
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('recall_window_passed');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('paid + no refund: SUCCESS — flips refundStatus to requested (guarded repo transition) and hints 3-5 business days', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(id);
    expect(String(r.reply_hint)).toContain('3-5 business days once approved');
    expectCustomerSafe(r);
    const after = await ctx.store.getTransfer(id);
    expect(after?.refundStatus).toBe('requested');
    expect(after?.status).toBe('paid'); // the forward-only status machine is untouched
  });

  it('a second request is a no-op: "already being reviewed", state unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await executeTool('request_refund', { transfer_id: id }, ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.requested).toBeUndefined();
    expect(r.error_code).toBe('already_requested');
    expect(String(r.message).toLowerCase()).toContain('already being reviewed');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus).toBe('requested');
  });

  it('refund pending (ops approved): explains it is on the way — 3-5 business days', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('refund_in_progress');
    expect(String(r.message)).toContain('3-5 business days');
    expectCustomerSafe(r);
  });

  it('refund completed: already refunded to the original payment method', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'completed' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('already_refunded');
    expect(String(r.message).toLowerCase()).toContain('original payment method');
    expectCustomerSafe(r);
  });

  it("refund failed is OPS-INTERNAL: the customer hears 'being reviewed', never the word failed", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'failed' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    // 'failed' maps to the in_progress disposition — the customer hears the team
    // is on it, never the word failed.
    expect(r.error_code).toBe('refund_in_progress');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('fail');
    expectCustomerSafe(r);
  });

  it('cancelled with a refund already moving: explains the current refund state', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await forceStatus(ctx, id, 'cancelled');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('refund_in_progress');
    expectCustomerSafe(r);
  });

  it('cancelled with no refund in motion: points to help, sets no flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'cancelled');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('cancelled');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('blocked: never charged ⇒ nothing to refund (no screening detail beyond the receipt wording)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'blocked');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('never_charged');
    expect(String(r.message).toLowerCase()).toContain('not charged');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('blocked');
    expectCustomerSafe(r);
  });

  it('in_review: not refundable yet — the established "under review" wording only', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'in_review');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('under_review');
    expect(String(r.message).toLowerCase()).toContain('under review');
    expectCustomerSafe(r);
  });

  // ── transfer_id OMITTED: resolve from the customer's own recent transfers ──

  // Mint a small ($100) transfer so two fit inside the T0 daily cap ($500/day).
  async function mintSmall(ctx: Ctx): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 100,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  it('no transfer_id: resolves the latest REFUNDABLE (paid) transfer and flags it', async () => {
    const ctx = await buildCtx(fakeRedis());
    // An older delivered (window-passed) transfer + a newer paid one. With no id,
    // request_refund must prefer the refundable (paid) one even though it is not
    // the absolute newest by createdAt. ($100 each keeps both within the cap.)
    const deliveredId = await mintSmall(ctx);
    await ctx.store.updateTransferFromWebhook(deliveredId, 'delivered');
    const t = (await ctx.store.getTransfer(deliveredId))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // window passed
    });
    const paidId = await mintSmall(ctx);
    expect(await ctx.store.updateTransferFromWebhook(paidId, 'paid')).not.toBeNull();

    const r = await executeTool('request_refund', {}, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(paidId);
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(paidId))?.refundStatus).toBe('requested');
    // The window-passed delivered one was untouched.
    expect((await ctx.store.getTransfer(deliveredId))?.refundStatus ?? 'none').toBe('none');
  });

  it("a '#'-prefixed id (as rendered in the [RECENT TRANSFERS] note) still resolves", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    // The note renders ids as "#<id>"; the model may copy that verbatim.
    const r = await executeTool('request_refund', { transfer_id: `#${id}` }, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(id); // resolved despite the leading '#'
    expect((await ctx.store.getTransfer(id))?.refundStatus).toBe('requested');
  });

  it('no transfer_id and no transfers at all ⇒ no_transfer_found (nothing flagged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_refund', {}, ctx);
    expect(r.error_code).toBe('no_transfer_found');
    expectCustomerSafe(r);
  });

  it('no transfer_id: latest is delivered-within-window ⇒ use_recall', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await ctx.store.updateTransferFromWebhook(id, 'delivered'); // deliveredAt = now()
    const r = await executeTool('request_refund', {}, ctx);
    expect(r.error_code).toBe('use_recall');
    expect(r.transfer_id).toBe(id);
    expectCustomerSafe(r);
  });
});

describe('open_recall_dispute (delivered-within-24h recall/dispute case)', () => {
  type Ctx = Awaited<ReturnType<typeof buildCtx>>;

  async function mintDelivered(ctx: Ctx): Promise<string> {
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
    const id = created.transfer_id as string;
    await ctx.store.updateTransferFromWebhook(id, 'paid');
    await ctx.store.updateTransferFromWebhook(id, 'delivered'); // deliveredAt = now()
    return id;
  }

  it('delivered within 24h ⇒ opens a customer ticket (category refund) and returns opened:true', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_recipient' }, ctx);
    expect(r.opened).toBe(true);
    expect(typeof r.case_id).toBe('string');
    expect(String(r.case_id)).toMatch(/^tk_/);
    expect(String(r.reply_hint).toLowerCase()).toContain('recovery is not guaranteed');

    // Assert the ticket landed via the repo: customer-scoped, linked + categorized.
    const repo = createTicketRepo(db);
    const mine = await repo.listByCustomer(ctx.phone);
    const ticket = mine.find((t) => t.id === r.case_id)!;
    expect(ticket).toBeTruthy();
    expect(ticket.kind).toBe('customer');
    expect(ticket.transferId).toBe(id);
    expect(ticket.category).toBe('refund');
    expect(ticket.subject.toLowerCase()).toContain('recall');
  });

  it('no transfer_id: resolves the latest delivered-within-window transfer', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { reason: 'not_received' }, ctx);
    expect(r.opened).toBe(true);
    const repo = createTicketRepo(db);
    const ticket = (await repo.listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
    expect(ticket.transferId).toBe(id);
  });

  it("a '#'-prefixed id (from the note) resolves and opens the case", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: `#${id}`, reason: 'wrong_amount' }, ctx);
    expect(r.opened).toBe(true);
    const repo = createTicketRepo(db);
    const ticket = (await repo.listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
    expect(ticket.transferId).toBe(id);
  });

  it('delivered over 24h ago ⇒ recall_window_passed, NO ticket opened', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, ctx);
    expect(r.error_code).toBe('recall_window_passed');
    expect(r.opened).toBeUndefined();
    const repo = createTicketRepo(db);
    expect(await repo.listByCustomer(ctx.phone)).toHaveLength(0);
  });

  it('a still-refundable (paid, not delivered) transfer ⇒ use_request_refund, no ticket', async () => {
    const ctx = await buildCtx(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    const id = created.transfer_id as string;
    await ctx.store.updateTransferFromWebhook(id, 'paid');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBe('use_request_refund');
    expect(r.transfer_id).toBe(id);
    const repo = createTicketRepo(db);
    expect(await repo.listByCustomer(ctx.phone)).toHaveLength(0);
  });

  it("STRICT ownership: another customer's delivered transfer reads as not found", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintDelivered(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'unauthorized' }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
  });

  it('respects the open-case cap (5) — a 6th recall is refused, no ticket', async () => {
    const ctx = await buildCtx(fakeRedis());
    const repo = createTicketRepo(db);
    // Pre-fill the cap with 5 open customer tickets.
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({
        id: `tk_pre${i}`,
        partnerId: 'default',
        kind: 'customer',
        customerPhone: ctx.phone,
        subject: `existing ${i}`,
        body: 'open case',
      });
    }
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBe('too_many_open_cases');
    expect(r.opened).toBeUndefined();
    // Still exactly 5 — nothing new opened.
    expect((await repo.listByCustomer(ctx.phone)).length).toBe(5);
  });
});

// ── B5: web channel — allowlist filters BOTH schemas and dispatch ────────────

describe('WEB_TOOL_ALLOWLIST + toolSchemasForChannel (B5)', () => {
  it('the allowlist is exactly the twelve read-only/refund/recall/pay-link tools', () => {
    expect([...WEB_TOOL_ALLOWLIST].sort()).toEqual([
      'check_payment_status',
      'check_send_limit',
      'generate_payment_link',
      'get_quote',
      'list_recent_transfers',
      'list_saved_recipients',
      'list_schedules',
      'open_recall_dispute',
      'repeat_transfer',
      'request_refund',
      'resolve_recipient',
      'validate_phone',
    ]);
  });

  it("toolSchemasForChannel('web') exposes ONLY allowlisted tools", () => {
    const names = toolSchemasForChannel('web').map((t) => t.function.name);
    expect(names.sort()).toEqual([...WEB_TOOL_ALLOWLIST].sort());
    expect(names).toContain('list_recent_transfers');
    expect(names).not.toContain('create_transfer');
    expect(names).not.toContain('send_approve_picker');
    expect(names).not.toContain('send_recipient_picker');
    expect(names).not.toContain('create_schedule');
  });

  it("toolSchemasForChannel('whatsapp') is the full set MINUS web-only tools", () => {
    const names = toolSchemasForChannel('whatsapp').map((t) => t.function.name);
    // Every roster tool except the web-only ones (list_recent_transfers).
    expect(names).not.toContain('list_recent_transfers');
    expect(names).toContain('create_transfer'); // a WhatsApp-only tool is still present
    expect(toolSchemasForChannel('whatsapp')).toHaveLength(toolSchemas.length - WEB_ONLY_TOOLS.size);
  });
});

describe('executeTool web dispatch gate (B5 defense-in-depth)', () => {
  const BLOCKED = [
    'create_transfer',
    'create_schedule',
    'cancel_schedule',
    'cancel_draft',
    'update_recipient_phone',
    'capture_corridor_request',
    'send_recipient_picker',
    'send_approve_picker',
  ];

  it.each(BLOCKED)('%s on web returns { error: "not available here" }', async (name) => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(name, {}, ctx);
    expect(r).toEqual({ error: 'not available here' });
  });

  it('a blocked send_approve_picker performs NO side effect — no draft, no send', async () => {
    const base = await buildCtx(fakeRedis());
    const ctx = { ...base, channel: 'web' as const };
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    const r = await executeTool(
      'send_approve_picker',
      { amount_usd: 100, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: '919876543210' },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(createDraft).not.toHaveBeenCalled();
    // No WhatsApp interactive left the building.
    const waCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('graph.facebook.com'));
    expect(waCalls).toHaveLength(0);
  });

  it('a blocked create_transfer mints NOTHING', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('a blocked create_schedule saves NOTHING', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(
      'create_schedule',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer', frequency: 'monthly', day_of_month: 5 },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(0);
  });

  it('allowlisted tools still execute on web (validate_phone, check_payment_status)', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const v = await executeTool('validate_phone', { phone: '+91 98765 43210' }, ctx);
    expect(v.valid).toBe(true);

    const created = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      { ...ctx, channel: 'whatsapp' as const }, // mint via the WhatsApp channel
    );
    const status = await executeTool('check_payment_status', { transfer_id: created.transfer_id }, ctx);
    expect(status.status).toBe('awaiting_payment');
  });

  it('the default channel (absent) is whatsapp — dispatch unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(typeof r.transfer_id).toBe('string');
  });

  it('request_refund on web keeps its ownership + paid-only guards', async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      owner,
    );
    const id = created.transfer_id as string;

    // Not paid yet ⇒ nothing to refund, even on web.
    const notPaid = await executeTool('request_refund', { transfer_id: id }, { ...owner, channel: 'web' as const });
    expect(notPaid.error_code).toBe('not_paid_yet');

    // A stranger on web reads it as not found (404-never-403).
    const stranger = { ...(await buildCtx(redis, '15559990000')), channel: 'web' as const };
    const theft = await executeTool('request_refund', { transfer_id: id }, stranger);
    expect(theft).toEqual({ error: 'Transfer not found.' });

    // Paid + owned ⇒ the one eligible state — works identically on web.
    await owner.store.updateTransferFromWebhook(id, 'paid');
    const ok = await executeTool('request_refund', { transfer_id: id }, { ...owner, channel: 'web' as const });
    expect(ok.requested).toBe(true);
  });
});

describe('list_recent_transfers (web-only history lookup)', () => {
  const HISTORY_URL = 'https://smartremit.test/account/history';

  // Past sends happened in the bot ⇒ mint via the WhatsApp channel (create_transfer
  // is blocked on web). Small amounts keep the T0 $500/day cap clear.
  const send = (
    ctx: Awaited<ReturnType<typeof buildCtx>>,
    name: string,
    phone: string,
    amount: number,
  ) =>
    executeTool(
      'create_transfer',
      {
        amount_usd: amount,
        recipient_name: name,
        recipient_phone: phone,
        payout_method: 'upi',
        payout_destination: `${name.toLowerCase()}@okhdfc`,
        funding_method: 'bank_transfer',
      },
      ctx, // whatsapp channel
    );

  it('lists the customer OWN recent sends with a customer-safe shape + history_url', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    const ctx = { ...base, channel: 'web' as const };

    const r = await executeTool('list_recent_transfers', {}, ctx);
    expect(r.history_url).toBe(HISTORY_URL);
    expect(r.count).toBe(2);
    const transfers = r.transfers as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    expect(transfers.map((t) => t.recipient_name).sort()).toEqual(['Dad', 'Mom']);
    // customer-safe fields only — no payout account / compliance / tenant keys.
    const dad = transfers.find((t) => t.recipient_name === 'Dad')!;
    expect(Object.keys(dad).sort()).toEqual(['amount', 'date', 'recipient_name', 'status', 'transfer_id']);
    expect(dad.status).toBe('awaiting payment');
    expect(String(dad.amount)).toContain('40');
    expect(typeof dad.transfer_id).toBe('string');
  });

  it("filters to the named recipient ('mom') case-insensitively", async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    await send(base, 'Mom', '919876543210', 25);
    const ctx = { ...base, channel: 'web' as const };

    const r = await executeTool('list_recent_transfers', { recipient: 'mom' }, ctx);
    const transfers = r.transfers as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.recipient_name === 'Mom')).toBe(true);
  });

  it('honors a clamped limit but reports the TOTAL match count', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    const ctx = { ...base, channel: 'web' as const };
    const r = await executeTool('list_recent_transfers', { limit: 1 }, ctx);
    expect((r.transfers as unknown[]).length).toBe(1); // returned list is capped
    expect(r.count).toBe(2); // ...but count is the full number of matches
  });

  it('returns an empty list (still with history_url) when nothing matches', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    const ctx = { ...base, channel: 'web' as const };
    const r = await executeTool('list_recent_transfers', { recipient: 'nobody' }, ctx);
    expect(r).toEqual({ transfers: [], count: 0, history_url: HISTORY_URL });
  });

  it("NEVER returns another customer's transfers (own-phone scoping)", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    await send(owner, 'Mom', '919876543210', 30);
    const stranger = await buildCtx(redis, '15559990000');
    await send(stranger, 'Dad', '919811112222', 40);

    const mine = await executeTool('list_recent_transfers', {}, { ...owner, channel: 'web' as const });
    expect((mine.transfers as Array<Record<string, unknown>>).map((t) => t.recipient_name)).toEqual(['Mom']);
    const theirs = await executeTool('list_recent_transfers', {}, { ...stranger, channel: 'web' as const });
    expect((theirs.transfers as Array<Record<string, unknown>>).map((t) => t.recipient_name)).toEqual(['Dad']);
  });

  it('is BLOCKED off the web channel (web-only) — returns not available here', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    // default channel (absent ⇒ whatsapp)
    expect(await executeTool('list_recent_transfers', {}, base)).toEqual({ error: 'not available here' });
    // explicit whatsapp
    expect(
      await executeTool('list_recent_transfers', {}, { ...base, channel: 'whatsapp' as const }),
    ).toEqual({ error: 'not available here' });
  });
});

describe('repeat_transfer on the web channel (B5 safe degrade)', () => {
  const seedPast = async (ctx: Awaited<ReturnType<typeof buildCtx>>) => {
    await executeTool(
      'create_transfer',
      {
        amount_usd: 200,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@okhdfc',
        funding_method: 'bank_transfer',
      },
      ctx, // whatsapp channel — the past send happened in the bot
    );
  };

  it('returns the summary + canonical pay_url instead of sending a WhatsApp card', async () => {
    const base = await buildCtx(fakeRedis());
    await seedPast(base);
    const ctx = { ...base, channel: 'web' as const };
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.sent).toBeUndefined(); // never claims an interactive was sent
    expect(typeof r.draft_id).toBe('string');
    expect(String(r.pay_url)).toBe(`https://smartremit.test/pay/${r.draft_id}`);
    expect(String(r.summary)).toContain('Mom');

    // The draft is REAL (same path the pay page consumes) with the real account.
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(200);

    // …and no WhatsApp send happened.
    const waCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('graph.facebook.com'));
    expect(waCalls).toHaveLength(0);
  });

  it('EDD-required repeats degrade to a WhatsApp hand-off (no half-collected answers)', async () => {
    const base = await buildCtx(fakeRedis());
    await seedPast(base);
    await base.monthlyVolumeStore.addCents(base.phone, 300000); // over the $3k month threshold
    const ctx = { ...base, channel: 'web' as const };
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');

    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(String(r.error).toLowerCase()).toContain('whatsapp');
    expect(r.sent).toBeUndefined();
    expect(r.pay_url).toBeUndefined();
    expect(r.payout_destination).toBeUndefined(); // the WhatsApp-shaped hydration payload stays home
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('on WhatsApp the same repeat still sends the approve card (unchanged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPast(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(r.pay_url).toBeUndefined(); // the link rides the CTA card, never the result
  });
});

describe('transfer-id tools — strict ownership (404-never-403, both channels)', () => {
  async function mintFor(ctx: Awaited<ReturnType<typeof buildCtx>>): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  it("check_payment_status: another customer's id reads as not found", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    for (const channel of ['whatsapp', 'web'] as const) {
      const r = await executeTool('check_payment_status', { transfer_id: id }, { ...stranger, channel });
      expect(r).toEqual({ error: 'Transfer not found.' });
    }
    // The owner still reads their own.
    const mine = await executeTool('check_payment_status', { transfer_id: id }, owner);
    expect(mine.status).toBe('awaiting_payment');
  });

  it("generate_payment_link: never mints a pay link for another customer's transfer", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    for (const channel of ['whatsapp', 'web'] as const) {
      const r = await executeTool('generate_payment_link', { transfer_id: id }, { ...stranger, channel });
      expect(r).toEqual({ error: 'Transfer not found.' });
    }
    const mine = await executeTool('generate_payment_link', { transfer_id: id }, owner);
    expect(mine.url).toBe(`https://smartremit.test/pay/${id}`);
  });

  it("update_recipient_phone: never mutates another customer's transfer", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('update_recipient_phone', { transfer_id: id, recipient_phone: '919999999999' }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expect((await owner.store.getTransfer(id))?.recipientPhone).toBe('919876543210'); // untouched
  });
});

// ── U1: present_bill + B2B create (Phase 1+2) ────────────────────────────────
describe('present_bill — B2B mock invoice lookup (WhatsApp channel)', () => {
  beforeEach(async () => {
    // b2b_invoices is not in freshDb's TRUNCATE set — clear it per test so the
    // buyer's "unpaid" lookup is deterministic.
    await db.execute(sql`TRUNCATE b2b_invoices`);
  });

  it('present_bill is a WhatsApp-only tool (in toolSchemas, NOT web-allowlisted)', () => {
    expect(toolSchemas.map((t) => t.function.name)).toContain('present_bill');
    expect(WEB_TOOL_ALLOWLIST.has('present_bill')).toBe(false);
    expect(WEB_ONLY_TOOLS.has('present_bill')).toBe(false); // visible on WhatsApp
    expect(toolSchemasForChannel('whatsapp').map((t) => t.function.name)).toContain('present_bill');
    expect(toolSchemasForChannel('web').map((t) => t.function.name)).not.toContain('present_bill');
  });

  it('returns the structured bill (seller, line items, total) for the buyer', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.saveB2bInvoice({
      id: 'inv_u1', partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: PHONE,
      lineItems: [
        { description: 'Widgets', qty: 100, unitAmountUsd: 10 },
        { description: 'Gadgets', qty: 5, unitAmountUsd: 40 },
      ],
      amountUsd: 1200, currency: 'USD', status: 'unpaid',
      createdAt: new Date().toISOString(),
    });
    const r = await executeTool('present_bill', {}, ctx);
    expect(r.has_bill).toBe(true);
    const inv = r.invoice as Record<string, unknown>;
    expect(inv.invoice_id).toBe('inv_u1');
    expect(inv.seller_business_name).toBe('Globex Trading LLC');
    expect(inv.amount_usd).toBe(1200);
    expect(inv.line_items).toEqual([
      { description: 'Widgets', qty: 100, unit_amount_usd: 10 },
      { description: 'Gadgets', qty: 5, unit_amount_usd: 40 },
    ]);
  });

  it('returns has_bill:false (clean no-op, never an error) when no unpaid invoice', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('present_bill', {}, ctx);
    expect(r).toEqual({ has_bill: false });
  });

  it('present_bill is blocked at dispatch on the web channel', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.saveB2bInvoice({
      id: 'inv_web', partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: PHONE, lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 10 }],
      amountUsd: 10, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
    });
    const r = await executeTool('present_bill', {}, { ...ctx, channel: 'web' });
    expect(r).toEqual({ error: 'not available here' });
  });
});

describe('create_transfer — B2B (business-to-business, ach_pull, non-custodial)', () => {
  it('mints a b2b transfer: discriminators, business names, invoice link; never captures funds', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('create_transfer', {
      amount_source: 400,                          // within the seeded T0 $500/day cap
      recipient_name: 'Globex Trading LLC',       // payee business legal name
      recipient_phone: '919876543210',
      funding_method: 'ach_pull',
      entity_type: 'business',
      sender_business_name: 'Acme Imports Ltd',    // payer business legal name
      recipient_business_name: 'Globex Trading LLC',
      invoice_id: 'inv_u1',
    }, ctx);

    expect(result.status).toBe('awaiting_payment'); // non-custodial: no capture at mint
    expect(result.compliance_status).toBe('cleared');

    const saved = await ctx.store.getTransferDecrypted(result.transfer_id as string);
    expect(saved?.transferType).toBe('b2b');
    expect(saved?.senderEntityType).toBe('business');
    expect(saved?.recipientEntityType).toBe('business');
    expect(saved?.senderBusinessName).toBe('Acme Imports Ltd');
    expect(saved?.recipientBusinessName).toBe('Globex Trading LLC');
    expect(saved?.fundingMethod).toBe('ach_pull'); // flat $1.99 ACH-pull fee (fx.ts), $0 on first send
    expect(saved?.invoiceId).toBe('inv_u1');
    expect(saved?.achTokenRef).toBeUndefined();     // bound at pay time (U2), NEVER here
  });

  it('a consumer create with no B2B args stays byte-for-byte b2c (path unchanged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('create_transfer', {
      amount_usd: 500, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    const saved = await ctx.store.getTransfer(result.transfer_id as string);
    expect(saved?.transferType).toBe('b2c');
    expect(saved?.senderEntityType).toBe('individual');
    expect(saved?.recipientEntityType).toBe('individual');
    expect(saved?.senderBusinessName).toBeUndefined();
    expect(saved?.invoiceId).toBeUndefined();
  });
});

describe('send_approve_picker — B2B draft → approve-tap mint threads business fields', () => {
  it('carries b2b discriminators + business names + invoice through the draft to the mint', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    // Prime the FX rate cache BEFORE we replace fetch with the WhatsApp-send stub.
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'ach_pull' }, ctx);
    // Stub fetch for the CTA send (returns ok + text + json so both FX and the
    // WhatsApp Cloud API call are satisfied). No real network, no money moves.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, text: async () => '', json: async () => ({ rates: { INR: MOCK_RATE } }),
    })));
    // Show the B2B approval card (creates a draft; sends a CTA, no money moves).
    const picker = await executeTool('send_approve_picker', {
      amount_source: 400,                          // within the seeded T0 $500/day cap
      funding_method: 'ach_pull',
      entity_type: 'business',
      recipient_name: 'Globex Trading LLC',
      recipient_business_name: 'Globex Trading LLC',
      sender_business_name: 'Acme Imports Ltd',
      recipient_phone: '919876543210',
      invoice_id: 'inv_u1',
    }, ctx);
    const draftId = picker.draft_id as string;
    expect(draftId).toBeTruthy();

    // Approve-tap mint path: the system supplies the draftId via button-tap ctx.
    const tapCtx = { ...ctx, turn: { isNewConversation: false, buttonTap: { kind: 'approve', draftId } } as const };
    const minted = await executeTool('create_transfer', {}, tapCtx);
    expect(minted.status).toBe('awaiting_payment');

    const saved = await ctx.store.getTransferDecrypted(minted.transfer_id as string);
    expect(saved?.transferType).toBe('b2b');
    expect(saved?.senderEntityType).toBe('business');
    expect(saved?.recipientEntityType).toBe('business');
    expect(saved?.senderBusinessName).toBe('Acme Imports Ltd');
    expect(saved?.recipientBusinessName).toBe('Globex Trading LLC');
    expect(saved?.fundingMethod).toBe('ach_pull');
    expect(saved?.invoiceId).toBe('inv_u1');
    expect(saved?.achTokenRef).toBeUndefined(); // bound at pay time (U2)
  });
});
