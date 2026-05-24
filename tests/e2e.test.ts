import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { completePaymentStage1, completePaymentStage2 } from '@/lib/payment';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage } from '@/lib/types';

const PHONE = '15551234567';
const MOCK_RATE = 85.2;

function toolCall(id: string, name: string, args: object): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: MOCK_RATE } }),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('end-to-end happy path', () => {
  it('quotes, creates a transfer, sends a link, and delivers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const scheduleStore = createScheduleStore(redis);

    // Scripted Kimi: quote -> create -> link -> final reply.
    const script: ChatMessage[] = [
      toolCall('c1', 'get_quote', {
        amount_usd: 500,
        funding_method: 'bank_transfer',
      }),
      toolCall('c2', 'create_transfer', {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      }),
      toolCall('c3', 'generate_payment_link', {
        transfer_id: 'PLACEHOLDER',
      }),
      {
        role: 'assistant',
        content: 'Tap the link to pay securely and your mom gets the money.',
      },
    ];
    let turn = 0;
    const agent = createAgent({
      store,
      scheduleStore,
      async chat() {
        const msg = script[turn++];
        // Patch the real transfer id into the link tool call.
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const transferKey = [...redis.dump.keys()].find((k) =>
            k.startsWith('transfer:'),
          )!;
          const id = transferKey.replace('transfer:', '');
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: id,
          });
        }
        return msg;
      },
    });

    const reply = await agent.runAgentTurn(
      PHONE,
      'send $500 to my mom on UPI mom@upi',
    );
    expect(reply).toContain('pay');

    // A transfer was created and the user count incremented.
    const transferKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('transfer:'),
    )!;
    const transferId = transferKey.replace('transfer:', '');
    expect(await store.getTransferCount(PHONE)).toBe(1);

    // Completing payment: stage 1 marks paid, stage 2 delivers.
    const stage1 = await completePaymentStage1(store, transferId);
    expect(stage1.transfer.status).toBe('paid');
    expect(stage1.senderMessages[0]).toContain('42,600');

    const stage2 = await completePaymentStage2(store, transferId);
    expect(stage2.transfer.status).toBe('delivered');
    expect(stage2.senderMessages[0]).toContain('42,600');

    // First transfer was free.
    expect(stage2.transfer.feeUsd).toBe(0);
  });
});
