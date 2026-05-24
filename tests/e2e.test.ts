import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
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
    const draftStore = createDraftStore(redis);

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
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const agent = createAgent({
      store,
      scheduleStore,
      draftStore,
      customerStore,
      dailyVolumeStore,
      kycProvider,
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

describe('end-to-end returning customer', () => {
  it('seeded recipient → picker → tap Mom → amount → quote → tap Approve → delivered', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const draftStore = createDraftStore(redis);
    const scheduleStore = createScheduleStore(redis);

    // Pre-seed: Mom is a saved recipient from a previous (mock) transfer.
    await store.upsertRecipient(PHONE, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      lastUsedAt: '2026-05-01T00:00:00Z',
    });

    // Turn 1: "[NEW CONVERSATION] hi" — bot calls list + send_recipient_picker.
    const turn1Script: ChatMessage[] = [
      toolCall('c1', 'list_saved_recipients', {}),
      toolCall('c2', 'send_recipient_picker', {
        recipients: [{ name: 'Mom', recipient_phone: '919876543210' }],
      }),
      { role: 'assistant', content: 'Welcome back 👋 Who are we sending to?' },
    ];
    // Turn 2: user taps Mom → bot asks "how much".
    const turn2Script: ChatMessage[] = [
      { role: 'assistant', content: 'How much do you want to send to Mom?' },
    ];
    // Turn 3: user says "$300" → bot calls send_approve_picker → asks for funding? In
    // this scripted run we assume the bot already knows enough; in reality the
    // prompt would have it ask for the funding method too. For test simplicity we
    // collapse that into a single tool call.
    const turn3Script: ChatMessage[] = [
      toolCall('c3', 'send_approve_picker', {
        amount_usd: 300,
        funding_method: 'bank_transfer',
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      }),
      { role: 'assistant', content: 'Quote ready — tap Approve to send.' },
    ];
    // Turn 4: user taps Approve → bot calls create_transfer (no args) → generate_payment_link.
    const turn4Script: ChatMessage[] = [
      toolCall('c4', 'create_transfer', {}),
      toolCall('c5', 'generate_payment_link', { transfer_id: 'PLACEHOLDER' }),
      { role: 'assistant', content: 'Tap to pay securely.' },
    ];

    const allScripts = [turn1Script, turn2Script, turn3Script, turn4Script];
    let activeScript: ChatMessage[] = [];
    let scriptIdx = 0;

    // Stub fetch for both FX and WhatsApp Cloud API (no-op success).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rates: { INR: 85.2 } }),
        text: async () => '',
      }),
    );

    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const agent = createAgent({
      store,
      scheduleStore,
      draftStore,
      customerStore,
      dailyVolumeStore,
      kycProvider,
      async chat() {
        const msg = activeScript.shift()!;
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const key = [...redis.dump.keys()].find((k) =>
            k.startsWith('transfer:'),
          )!;
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: key.replace('transfer:', ''),
          });
        }
        return msg;
      },
    });

    // --- Turn 1: new conversation, picker should send.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: true });

    // --- Turn 2: user taps Mom.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(
      PHONE,
      `[Tapped: Send to recipient 919876543210]`,
      {
        isNewConversation: false,
        buttonTap: { kind: 'recipient', recipientPhone: '919876543210' },
      },
    );

    // --- Turn 3: user types "$300" — bot sends approve picker, creates draft.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(PHONE, '$300', { isNewConversation: false });

    // A draft must now exist.
    const draftKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('recipient_draft:'),
    );
    expect(draftKey).toBeDefined();
    const draftId = draftKey!.replace('recipient_draft:', '');

    // --- Turn 4: user taps Approve.
    activeScript = [...allScripts[scriptIdx++]];
    await agent.runAgentTurn(
      PHONE,
      '[Tapped: Approve & pay]',
      {
        isNewConversation: false,
        buttonTap: { kind: 'approve', draftId },
      },
    );

    // A transfer must have been created.
    const transferKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('transfer:'),
    );
    expect(transferKey).toBeDefined();

    // The draft must have been consumed.
    expect(await draftStore.getDraft(draftId)).toBeNull();

    // The recipient's lastUsedAt must have advanced past the seed.
    const recipients = await store.listRecipients(PHONE, 3);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].lastUsedAt > '2026-05-01T00:00:00Z').toBe(true);
  });
});
