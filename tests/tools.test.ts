import { describe, it, expect } from 'vitest';
import { executeTool, toolSchemas } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';

describe('toolSchemas', () => {
  it('exposes all four tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'check_payment_status',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
    ]);
  });
});

describe('executeTool', () => {
  it('get_quote returns a free first quote', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 500, payout_method: 'upi' },
      { phone: PHONE, store },
    );
    expect(result.fee_usd).toBe(0);
    expect(result.amount_inr).toBe(Math.round(500 * 85.2));
  });

  it('get_quote surfaces a validation error as { error }', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 5, payout_method: 'upi' },
      { phone: PHONE, store },
    );
    expect(result.error).toMatch(/between/i);
  });

  it('create_transfer persists a transfer and increments the user count', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    expect(result.status).toBe('awaiting_payment');
    const saved = await store.getTransfer(result.transfer_id as string);
    expect(saved?.recipientName).toBe('Mom');
    expect((await store.getUser(PHONE)).transferCount).toBe(1);
  });

  it('generate_payment_link builds a URL for an existing transfer', async () => {
    const store = createStore(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    const link = await executeTool(
      'generate_payment_link',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store },
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
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    const status = await executeTool(
      'check_payment_status',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store },
    );
    expect(status.status).toBe('awaiting_payment');
  });

  it('returns an error for an unknown tool', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool('nope', {}, { phone: PHONE, store });
    expect(result.error).toMatch(/unknown tool/i);
  });
});
