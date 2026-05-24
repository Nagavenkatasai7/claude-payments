import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTool, toolSchemas } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

const TURN = { isNewConversation: false } as const;

const PHONE = '15551234567';
const MOCK_RATE = 85.0;

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
  it('exposes all twelve tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_draft',
      'cancel_schedule',
      'check_payment_status',
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
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.fee_usd).toBe(0);
    expect(result.amount_inr).toBe(Math.round(500 * MOCK_RATE));
  });

  it('get_quote surfaces a validation error as { error }', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 5, funding_method: 'bank_transfer' },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.error).toMatch(/between/i);
  });

  it('get_quote uses credit_card surcharge for repeat transfers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    resetRateCacheForTests();
    stubFetch();
    // Second quote (repeat, credit_card)
    const result = await executeTool(
      'get_quote',
      { amount_usd: 100, funding_method: 'credit_card' },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    // fee = 2.99 + 3 = 5.99
    expect(result.fee_usd).toBe(5.99);
  });

  it('create_transfer persists a transfer and increments the user count', async () => {
    const store = createStore(fakeRedis());
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.status).toBe('awaiting_payment');
    expect(result.compliance_status).toBe('cleared');
    const saved = await store.getTransfer(result.transfer_id as string);
    expect(saved?.recipientName).toBe('Mom');
    expect(saved?.fundingMethod).toBe('debit_card');
    // recipientPhone should be normalized to digits only
    expect(saved?.recipientPhone).toBe('919876543210');
    expect(await store.getTransferCount(PHONE)).toBe(1);
  });

  it('create_transfer with watchlisted recipient returns blocked status', async () => {
    const store = createStore(fakeRedis());
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.compliance_status).toBe('blocked');
    expect(result.status).toBe('blocked');

    // generate_payment_link for a blocked transfer should return an error
    const linkResult = await executeTool(
      'generate_payment_link',
      { transfer_id: result.transfer_id },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(linkResult.error).toBeDefined();
    expect(linkResult.error).toMatch(/compliance/i);
  });

  it('create_transfer returns an error and does NOT persist when recipient_phone is missing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    // No transfer should have been persisted
    const transferKeys = [...redis.dump.keys()].filter((k) => k.startsWith('transfer:'));
    expect(transferKeys).toHaveLength(0);
  });

  it('create_transfer returns an error and does NOT persist when recipient_phone is invalid (too short)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    const transferKeys = [...redis.dump.keys()].filter((k) => k.startsWith('transfer:'));
    expect(transferKeys).toHaveLength(0);
  });

  it('generate_payment_link builds a URL for an existing transfer', async () => {
    const store = createStore(fakeRedis());
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    const link = await executeTool(
      'generate_payment_link',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(link.url).toBe(
      `https://sendhome.test/pay/${created.transfer_id}`,
    );
  });

  it('check_payment_status reports a transfer status', async () => {
    const store = createStore(fakeRedis());
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
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    const status = await executeTool(
      'check_payment_status',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
    );
    expect(status.status).toBe('awaiting_payment');
  });

  it('returns an error for an unknown tool', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool('nope', {}, { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN });
    expect(result.error).toMatch(/unknown tool/i);
  });

  describe('update_recipient_phone', () => {
    it('sets the normalized recipientPhone on an existing transfer', async () => {
      const store = createStore(fakeRedis());
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
        { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
      );
      const transferId = created.transfer_id as string;

      // Update with a formatted phone
      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: transferId, recipient_phone: '+91 98765 11111' },
        { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
      );
      expect(result.error).toBeUndefined();
      expect(result.recipient_phone).toBe('919876511111');
      expect(result.transfer_id).toBe(transferId);

      // Verify in the store
      const saved = await store.getTransfer(transferId);
      expect(saved?.recipientPhone).toBe('919876511111');
    });

    it('returns an error for an unknown transfer id', async () => {
      const store = createStore(fakeRedis());
      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: 'nonexistent-id', recipient_phone: '919876543210' },
        { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not found/i);
    });

    it('returns an error for an invalid phone number', async () => {
      const store = createStore(fakeRedis());
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
        { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
      );
      const transferId = created.transfer_id as string;

      const result = await executeTool(
        'update_recipient_phone',
        { transfer_id: transferId, recipient_phone: '123' },
        { phone: PHONE, store, scheduleStore: createScheduleStore(fakeRedis()), draftStore: createDraftStore(fakeRedis()), turn: TURN },
      );
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/valid/i);

      // Phone should remain unchanged
      const saved = await store.getTransfer(transferId);
      expect(saved?.recipientPhone).toBe('919876543210');
    });
  });
});

describe('schedule tools', () => {
  function ctx() {
    const redis = fakeRedis();
    return {
      phone: '15551234567',
      store: createStore(redis),
      scheduleStore: createScheduleStore(redis),
      draftStore: createDraftStore(redis),
      turn: TURN,
    };
  }

  it('create_schedule saves a monthly schedule', async () => {
    const c = ctx();
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
    }, ctx());
    expect(r.error).toMatch(/day of the month/i);
  });

  it('list_schedules returns only this customer active schedules', async () => {
    const c = ctx();
    await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'weekly', day_of_week: 5,
    }, c);
    const r = await executeTool('list_schedules', {}, c);
    expect((r.schedules as unknown[]).length).toBe(1);
  });

  it('cancel_schedule cancels an existing schedule', async () => {
    const c = ctx();
    const created = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, c);
    const saved = await c.scheduleStore.getSchedule(created.schedule_id as string);
    expect(saved?.status).toBe('cancelled');
  });
});
