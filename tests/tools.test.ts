import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTool, toolSchemas, buildApproveSummary, maskAccount } from '@/lib/tools';
import type { Quote } from '@/lib/types';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

const PHONE = '15551234567';
const MOCK_RATE = 85.0;

function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE) {
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  return {
    phone,
    store,
    scheduleStore: createScheduleStore(redis, customerStore),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore,
    monthlyVolumeStore,
    kycProvider,
    partnerStore: createPartnerStore(redis), // NEW (P4)
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

beforeEach(() => {
  resetRateCacheForTests();
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toolSchemas', () => {
  it('exposes all seventeen tools', () => {
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
      'list_saved_recipients',
      'list_schedules',
      'repeat_transfer',
      'resolve_recipient',
      'send_approve_picker',
      'send_recipient_picker',
      'update_recipient_phone',
      'validate_phone',
    ]);
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {}, ctx);
    expect(result.error).toBeDefined();
    expect(result.saved).toBeUndefined();
  });

  it('saves a lead without optional fields', async () => {
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {
      destination_country: 'Pakistan',
    }, ctx);
    expect(result.saved).toBe(true);
    const leads = await ctx.store.listCorridorRequests();
    expect(leads[0].approxAmount).toBeUndefined();
    expect(leads[0].approxCurrency).toBeUndefined();
  });

  it('does NOT return sent: true (agent still sends a text reply)', async () => {
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool('capture_corridor_request', {
      destination_country: 'UAE',
    }, ctx);
    expect(result.sent).toBeUndefined();
  });
});

describe('executeTool', () => {
  it('get_quote returns a free first quote', async () => {
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' },
      ctx,
    );
    expect(result.fee_usd).toBe(0);
    expect(result.amount_inr).toBe(Math.round(500 * MOCK_RATE));
  });

  it('get_quote surfaces a validation error as { error }', async () => {
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 5, funding_method: 'bank_transfer' },
      ctx,
    );
    expect(result.error).toMatch(/between/i);
  });

  it('get_quote uses credit_card surcharge for repeat transfers', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis);
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(redis);
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
    // No transfer should have been persisted
    const transferKeys = [...redis.dump.keys()].filter((k) => k.startsWith('transfer:'));
    expect(transferKeys).toHaveLength(0);
  });

  it('create_transfer returns an error and does NOT persist when recipient_phone is invalid (too short)', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis);
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
    const transferKeys = [...redis.dump.keys()].filter((k) => k.startsWith('transfer:'));
    expect(transferKeys).toHaveLength(0);
  });

  it('generate_payment_link builds a URL for an existing transfer', async () => {
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    const result = await executeTool('nope', {}, ctx);
    expect(result.error).toMatch(/unknown tool/i);
  });

  describe('update_recipient_phone', () => {
    it('sets the normalized recipientPhone on an existing transfer', async () => {
      const ctx = buildCtx(fakeRedis());
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
      const ctx = buildCtx(fakeRedis());
      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: 'nonexistent-id', recipient_phone: '919876543210' },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not found/i);
    });

    it('returns an error for an invalid phone number', async () => {
      const ctx = buildCtx(fakeRedis());
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
    const c = buildCtx(fakeRedis());
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
    const c = buildCtx(fakeRedis());
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
    const c = buildCtx(fakeRedis());
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
    }, buildCtx(fakeRedis()));
    expect(r.error).toMatch(/day of the month/i);
  });

  it('list_schedules returns only this customer active schedules', async () => {
    const c = buildCtx(fakeRedis());
    await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'weekly', day_of_week: 5,
    }, c);
    const r = await executeTool('list_schedules', {}, c);
    expect((r.schedules as unknown[]).length).toBe(1);
  });

  it('cancel_schedule cancels an existing schedule', async () => {
    const c = buildCtx(fakeRedis());
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
    const c = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 100 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.tier).toBe('T0');
    expect(r.daily_cap_usd).toBe(500);
    expect(r.today_remaining_usd).toBe(500);
    expect(r.day_of_window).toBe(1);
    expect(r.kyc_url).toBe('https://example.com/dashboard/customers/15550001111');
  });

  it('T0 customer over the per-transfer cap returns reason=over_per_transfer_cap', async () => {
    const ctx = buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 700 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
  });

  it('T0 customer over the daily cap (cumulative) returns reason=over_daily_cap', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15550001111');
    await ctx.customerStore.upsertOnFirstInbound('15550001111');
    await ctx.dailyVolumeStore.addCents('15550001111', 30_000); // $300 today
    const r = await executeTool('check_send_limit', { amount_usd: 300 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_used_usd).toBe(300);
    expect(r.today_remaining_usd).toBe(200);
  });

  it('zero-amount request returns within_cap=true (status-only)', async () => {
    const ctx = buildCtx(fakeRedis(), '15550001111');
    const r = await executeTool('check_send_limit', { amount_usd: 0 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.kyc_url).toBeDefined();
  });

  it('check_send_limit: dormant path returns edd_required:false with all today\'s fields intact', async () => {
    const ctx = buildCtx(fakeRedis(), '15550001111');
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
    const ctx = buildCtx(fakeRedis(), '15550001111');
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000); // $2,500 this month
    const res = await executeTool('check_send_limit', { amount_usd: 600 }, ctx); // → $3,100
    expect(res.edd_required).toBe(true);
  });

  it('check_send_limit: edd_required:false when the customer already has EDD fields on file (sticky)', async () => {
    const ctx = buildCtx(fakeRedis(), '15550001111');
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
    const ctx = buildCtx(redis, '15551234567');
    // Mark customer grandfathered so the cap doesn't block
    await ctx.customerStore.saveCustomer({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'grandfathered',
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
  async function grandfathered(ctx: ReturnType<typeof buildCtx>) {
    await ctx.customerStore.saveCustomer({
      senderPhone: ctx.phone,
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'grandfathered',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      partnerId: 'default',
    });
  }

  it('EDD enum args persist onto the Customer (sticky)', async () => {
    const ctx = buildCtx(fakeRedis(), '15551234567');
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
    const ctx = buildCtx(fakeRedis(), '15551234567');
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
    const base = buildCtx(redis, '15551234567');
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
    const transfer = await ctx.store.getTransfer(r.transfer_id as string);
    expect(transfer?.recipientLegalName).toBe('Mother Legal Name');
    expect(transfer?.relationship).toBe('parent');
    expect(transfer?.purpose).toBe('family_support');
  });
});

describe('multi-currency dormancy invariant', () => {
  it('get_quote for a multi-currency partner returns source_currency GBP and correct amounts', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15559991111');

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
      kycStatus: 'not_started',
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

  it('get_quote for a US-only partner ignores source_currency GBP request (dormant)', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15559992222');

    // Use the default partner (US only — ensureDefaultPartner gives countries: ['US'])
    // No need to seed a partner; resolveCurrencyAndRates will call ensureDefaultPartner

    // Even though we pass source_currency: 'GBP', it should be ignored for a ['US'] partner
    const result = await executeTool(
      'get_quote',
      { amount_usd: 200, funding_method: 'bank_transfer', source_currency: 'GBP' },
      ctx,
    );

    // Dormant: USD path, MOCK_RATE=85 (set in beforeEach stubFetch)
    expect(result.source_currency).toBe('USD');
    expect(result.amount_inr).toBe(Math.round(200 * MOCK_RATE));
    expect(result.error).toBeUndefined();
  });
});

describe('get_quote: receive-first (amount_inr) branch', () => {
  it('amount_inr back-solves the send amount; recipient gets ~the target INR', async () => {
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_inr: 42500, amount_usd: 9999, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBeCloseTo(500, 2); // from 42500/85, NOT 9999
  });

  it('send-first path is UNCHANGED when amount_inr is absent', async () => {
    const ctx = buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500);
    expect(res.amount_inr).toBe(Math.round(500 * 85));
  });

  it('a non-finite / non-positive amount_inr is ignored, falling back to amount_usd', async () => {
    const ctx = buildCtx(fakeRedis());
    const res = await executeTool('get_quote',
      { amount_inr: 'abc', amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500); // junk amount_inr did not hijack the quote
  });

  it('the back-solved amount still hits the MIN/MAX guard (QuoteError → error result)', async () => {
    const ctx = buildCtx(fakeRedis());
    // 85 INR → ~$1; below MIN_USD=10 ⇒ quote() throws QuoteError, surfaced as { error }
    const res = await executeTool('get_quote',
      { amount_inr: 85, funding_method: 'bank_transfer' }, ctx);
    expect('error' in res).toBe(true);
  });

  it('receive-first respects source_currency (GBP rates)', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15559991111');
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
      kycStatus: 'not_started',
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
    const ctx = buildCtx(redis, '15550002222');
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
    const ctx = buildCtx(redis, '15550003333');
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
    const ctx = buildCtx(redis, '15550004444');
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
    const ctx = buildCtx(fakeRedis(), '15550005555');
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
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '123456789 HDFC0001234', 'bank_transfer');
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
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '01-0123-0123456-00', 'bank_transfer');
    expect(s).toContain('bank a/c ****3456'); // longest digit run is 0123456
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
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '123456789 HDFC0001234', 'bank_transfer');
    expect(s).toContain('bank a/c ****6789');
    expect(s).not.toContain('their bank account (you');
  });
});

describe('validate_phone — read-only phone early-catch', () => {
  const call = (phone: unknown) =>
    executeTool('validate_phone', { phone }, {} as never); // ctx is never touched

  it('a clean 919876543210 → { valid: true, normalized }', async () => {
    expect(await call('919876543210')).toEqual({ valid: true, normalized: '919876543210' });
  });
  it('a formatted "+91 98765 43210" → valid, normalized digits-only', async () => {
    expect(await call('+91 98765 43210')).toEqual({ valid: true, normalized: '919876543210' });
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
    ctx: ReturnType<typeof buildCtx>,
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210' });
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919800000000' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(2);
  });

  it('returns match:ambiguous for a partial/substring match (never auto-proceeds)', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom (work)', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(1);
  });

  it('returns match:none when nothing matches (cold-start path)', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none');
  });

  it('only searches the calling sender\'s own recipients', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15551234567');
    const otherCtx = buildCtx(redis, '15559999999');
    await seedRecipient(otherCtx, { name: 'Mom', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none'); // the other sender's recipient is invisible
  });
});

describe('maskAccount — exported helper', () => {
  it('UPI: returns the address unchanged', () => {
    expect(maskAccount('upi', 'mom@okhdfc')).toBe('mom@okhdfc');
  });

  it('bank: collapses to ****<last4> of the longest digit run (account)', () => {
    // Account number (longer) wins over routing/IFSC; nothing else is shown
    expect(maskAccount('bank', '123456789 HDFC0001234')).toBe('****6789');
  });

  it('bank: same result when IFSC comes first (field order is irrelevant)', () => {
    expect(maskAccount('bank', 'HDFC0001234 123456789')).toBe('****6789');
  });

  it('bank: never includes the raw account number, even with no spaces (IBAN)', () => {
    const result = maskAccount('bank', 'AE070331234567890123456');
    expect(result).not.toContain('AE070331234567890123456');
    expect(result).toBe('****3456');
  });
});

describe('list_saved_recipients — payout_destination masking (Fix #1)', () => {
  it('bank recipient: full account number does NOT appear; last 4 do', async () => {
    const ctx = buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: '123456789 HDFC0001234',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('list_saved_recipients', {}, ctx);
    const rec = (r.recipients as Record<string, unknown>[])[0];
    expect(String(rec.payout_destination)).not.toContain('123456789');
    expect(String(rec.payout_destination)).toContain('6789');
  });

  it('UPI recipient: payout_destination returned unchanged', async () => {
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Priya',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: '987654321 SBIN0001234',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Priya' }, ctx);
    expect(r.match).toBe('exact');
    const dest = String((r.recipient as Record<string, unknown>).payout_destination);
    expect(dest).not.toContain('987654321');
    expect(dest).toContain('4321');
  });

  it('bank recipient: full account does NOT appear in ambiguous candidates', async () => {
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 700, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.fee_usd).toBeUndefined();        // NO quote presented
    expect(r.amount_inr).toBeUndefined();
    expect(typeof r.kyc_url).toBe('string');  // T0 → kyc_url surfaced
    expect(r.per_transfer_cap_usd).toBe(500);
  });

  it('refuses an over-daily amount and reports the remaining', async () => {
    const ctx = buildCtx(fakeRedis());
    await ctx.dailyVolumeStore.addCents(PHONE, 40_000); // $400 already used today
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_remaining_usd).toBe(100); // $500 cap − $400 used
    expect(r.fee_usd).toBeUndefined();
  });

  it('guards the receive-first (amount_inr) path too', async () => {
    const ctx = buildCtx(fakeRedis());
    // 70000 INR / 85 ≈ $823 USD-equiv → over the $500 per-transfer cap
    const r = await executeTool('get_quote', { amount_inr: 70000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.fee_usd).toBeUndefined();
  });

  it('still returns a normal quote when within cap (no within_cap field)', async () => {
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 300, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBeUndefined();     // success path unchanged
    expect(r.fee_usd).toBe(0);                // first transfer free
    expect(r.amount_inr).toBe(Math.round(300 * MOCK_RATE));
  });
});

describe('create_transfer records the sender\'s funding method (Bundle C)', () => {
  it('writes lastFundingMethod onto the customer after a successful create', async () => {
    const ctx = buildCtx(fakeRedis());
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
  const seedPastTransfer = async (ctx: ReturnType<typeof buildCtx>) => {
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
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const countBefore = await ctx.store.getTransferCount(ctx.phone);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // routed through the draft path — no new transfer created yet
    expect(await ctx.store.getTransferCount(ctx.phone)).toBe(countBefore);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(200); // reused last amount
  });

  it('honors an amount_usd override', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 250 }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.amountSource).toBe(250);
  });

  it('falls back to the sender\'s remembered funding method when none is given', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx); // last transfer used bank_transfer + records it as the default
    await ctx.customerStore.recordFundingMethod(ctx.phone, 'credit_card'); // newer default
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.fundingMethod).toBe('credit_card');
  });

  it('errors when there is no past transfer to that number', async () => {
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('repeat_transfer', { recipient_phone: '910000000000' }, ctx);
    expect(r.error).toBeDefined();
    expect(r.sent).toBeUndefined();
  });

  it('returns needs_edd (and does NOT send a card) when the month is over the EDD threshold', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    // push cumulative monthly volume over $3,000 so evaluateEdd trips; customer has no SoF/occupation
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 300000);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.payout_destination).toBe('mom@okhdfc'); // hydrated details returned for the follow-up
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(fakeRedis());
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
    const ctx = buildCtx(redis, '15550099999');
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
