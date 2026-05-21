import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent, sanitizeReply } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage } from '@/lib/types';

const PHONE = '15551234567';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: 85.2 } }),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAgent', () => {
  it('returns a plain reply when the model uses no tools', async () => {
    const store = createStore(fakeRedis());
    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(fakeRedis()),
      chat: async () => ({ role: 'assistant', content: 'Hi there!' }),
    });
    const reply = await agent.runAgentTurn(PHONE, 'hello');
    expect(reply).toBe('Hi there!');
  });

  it('executes a tool call, then returns the follow-up reply', async () => {
    const store = createStore(fakeRedis());
    const responses: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_quote',
              arguments: JSON.stringify({
                amount_usd: 500,
                funding_method: 'bank_transfer',
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'You send $500, they get a lot of INR.' },
    ];
    let call = 0;
    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(fakeRedis()),
      chat: async () => responses[call++],
    });

    const reply = await agent.runAgentTurn(PHONE, 'send $500 via upi');
    expect(reply).toBe('You send $500, they get a lot of INR.');

    const conv = await store.getConversation(PHONE);
    expect(conv.some((m) => m.role === 'tool')).toBe(true);
  });

  it('saves the conversation history after a turn', async () => {
    const store = createStore(fakeRedis());
    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(fakeRedis()),
      chat: async () => ({ role: 'assistant', content: 'noted' }),
    });
    await agent.runAgentTurn(PHONE, 'remember this');
    const conv = await store.getConversation(PHONE);
    expect(conv[0]).toEqual({ role: 'user', content: 'remember this' });
  });

  it('replaces a typo URL in the model reply with the canonical payment link', async () => {
    const store = createStore(fakeRedis());
    // The canonical URL is code-generated from APP_BASE_URL (https://sendhome.test in tests).
    const canonicalUrl = 'https://sendhome.test/pay/abc123';
    const typoUrl = 'https://claude-payments.verce.app/pay/abc123';

    // Round 1: model calls generate_payment_link tool
    // Round 2: model replies with the typo'd URL in prose
    const responses: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_gpl',
            type: 'function',
            function: {
              name: 'generate_payment_link',
              arguments: JSON.stringify({ transfer_id: 'abc123' }),
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: `Great! Here is your payment link: ${typoUrl} — please tap it to complete the transfer.`,
      },
    ];

    let call = 0;
    // Wire the store with a real transfer so executeTool's generatePaymentLinkTool
    // can find it and return the canonical URL from our code (not from the model).
    await store.saveTransfer({
      id: 'abc123',
      phone: PHONE,
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Priya',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'priya@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
    });

    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(fakeRedis()),
      chat: async () => responses[call++],
    });

    const reply = await agent.runAgentTurn(PHONE, 'pay now');

    // The returned string must contain the canonical URL
    expect(reply).toContain(canonicalUrl);
    // The returned string must NOT contain the typo domain
    expect(reply).not.toMatch(/verce\.app/);
  });

  it('keeps the raw model message in conversation history (unsanitized)', async () => {
    const store = createStore(fakeRedis());
    const typoUrl = 'https://claude-payments.verce.app/pay/abc123';
    const rawModelContent = `Here is your link: ${typoUrl}`;

    const responses: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_gpl2',
            type: 'function',
            function: {
              name: 'generate_payment_link',
              arguments: JSON.stringify({ transfer_id: 'abc123' }),
            },
          },
        ],
      },
      { role: 'assistant', content: rawModelContent },
    ];

    await store.saveTransfer({
      id: 'abc123',
      phone: PHONE,
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Priya',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'priya@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
    });

    let call = 0;
    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(fakeRedis()),
      chat: async () => responses[call++],
    });

    await agent.runAgentTurn(PHONE, 'pay now');

    // The conversation history should keep the raw (unsanitized) assistant message
    const conv = await store.getConversation(PHONE);
    const assistantMessages = conv.filter((m) => m.role === 'assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant.content).toBe(rawModelContent);
  });
});

describe('sanitizeReply', () => {
  it('strips a URL the model wrote', () => {
    const result = sanitizeReply(
      'Click here: https://claude-payments.verce.app/pay/abc',
      [],
    );
    expect(result).not.toMatch(/https?:\/\//);
    expect(result).toContain('Click here:');
  });

  it('appends the canonical payment link when one is provided', () => {
    const link = 'https://claude-payments.vercel.app/pay/abc123';
    const result = sanitizeReply('Your payment link is ready.', [link]);
    expect(result).toContain(link);
    expect(result.endsWith(link)).toBe(true);
  });

  it('strips a model-written URL and appends the canonical link', () => {
    const typo = 'https://claude-payments.verce.app/pay/abc123';
    const canonical = 'https://claude-payments.vercel.app/pay/abc123';
    const result = sanitizeReply(`Use this link: ${typo}`, [canonical]);
    expect(result).not.toContain(typo);
    expect(result).toContain(canonical);
    expect(result).not.toMatch(/verce\.app/);
  });

  it('with no payment links, just strips stray URLs', () => {
    const result = sanitizeReply(
      'Go to https://example.com for details.',
      [],
    );
    expect(result).not.toMatch(/https?:\/\//);
    expect(result).toContain('Go to');
    expect(result).toContain('for details.');
  });

  it('returns the link even when the reply text is empty', () => {
    const link = 'https://claude-payments.vercel.app/pay/abc123';
    // Caller applies the fallback before sanitizeReply, but test the function directly
    // with empty stripped text to confirm the link is not lost
    const result = sanitizeReply('', [link]);
    expect(result).toBe(link);
  });

  it('uses the last link in the array when multiple are provided', () => {
    const first = 'https://claude-payments.vercel.app/pay/first';
    const last = 'https://claude-payments.vercel.app/pay/last';
    const result = sanitizeReply('Done.', [first, last]);
    expect(result).toContain(last);
  });
});
