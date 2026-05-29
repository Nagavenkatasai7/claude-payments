import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTool, toolSchemas } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

const PHONE = '15551234567';
const MOCK_RATE = 85.0;

function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE) {
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  return {
    phone,
    store,
    scheduleStore: createScheduleStore(redis, customerStore),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore,
    kycProvider,
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
  it('exposes all thirteen tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_draft',
      'cancel_schedule',
      'check_payment_status',
      'check_send_limit',
      'create_schedule',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
      'list_saved_recipients',
      'list_schedules',
      'send_approve_picker',
      'send_recipient_picker',
      'update_recipient_phone',
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

  it('update_recipient_phone schema has transfer_id and recipient_phone', () => {
    const tool = toolSchemas.find((t) => t.function.name === 'update_recipient_phone')!;
    const props = tool.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('transfer_id');
    expect(props).toHaveProperty('recipient_phone');
    expect(tool.function.parameters.required).toContain('transfer_id');
    expect(tool.function.parameters.required).toContain('recipient_phone');
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
      `https://sendhome.test/pay/${created.transfer_id}`,
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

describe('send_approve_picker — cap enforcement', () => {
  it('refuses to send buttons and returns error when over cap', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15550002222');
    await ctx.customerStore.upsertOnFirstInbound('15550002222');
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
