import { describe, it, expect } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { completePayment } from '@/lib/payment';
import { fakeRedis } from './helpers';
import type { ChatMessage } from '@/lib/types';

const PHONE = '15551234567';

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

describe('end-to-end happy path', () => {
  it('quotes, creates a transfer, sends a link, and delivers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);

    // Scripted Kimi: quote -> create -> link -> final reply.
    const script: ChatMessage[] = [
      toolCall('c1', 'get_quote', {
        amount_usd: 500,
        payout_method: 'upi',
      }),
      toolCall('c2', 'create_transfer', {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
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
    expect((await store.getUser(PHONE)).transferCount).toBe(1);

    // Completing payment delivers the money.
    const result = await completePayment(store, transferId);
    expect(result.transfer.status).toBe('delivered');
    expect(result.messages[1]).toContain('42,600');

    // First transfer was free.
    expect(result.transfer.feeUsd).toBe(0);
  });
});
