import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import {
  buildSummaryContext,
  buildDeterministicSummary,
  createCustomerSummarizer,
  SUMMARY_SYSTEM_PROMPT,
  type CustomerSummarizerDeps,
} from '@/lib/customer-summary';
import type { ChatMessage, ChatTool, Customer, Partner, Transfer } from '@/lib/types';

/**
 * customer-summary — the AI smart-summary card on the customer dashboard.
 * Focus: the context builder only ever projects the customer's OWN masked
 * facts; the cache short-circuits the model; any model failure returns null;
 * and the no-advice/no-invention system prompt is pinned.
 */

const PHONE = '15550001111';

// Relative dates ONLY — fixed dates interact with the 3-day T0 window.
const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: days(30),
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: days(30),
    updatedAt: days(1),
    ...over,
  };
}

function partner(over: Partial<Partner> = {}): Partner {
  return {
    id: 'default',
    name: 'Default partner',
    countries: ['US'],
    status: 'active',
    ...over,
  } as Partner;
}

// A transfer row deliberately poisoned with everything that must NEVER reach
// the model: routing partner, compliance reasons, (masked) payout destination,
// recipient phone.
function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_1',
    phone: PHONE,
    amountUsd: 100,
    feeUsd: 2.99,
    totalChargeUsd: 102.99,
    fxRate: 83,
    amountInr: 8300,
    recipientName: 'Mom',
    recipientPhone: '917700543210',
    payoutMethod: 'bank',
    payoutDestination: '****4242',
    fundingMethod: 'debit_card',
    complianceStatus: 'cleared',
    complianceReasons: ['sanctions_screen_note'],
    status: 'delivered',
    createdAt: days(2),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    settlementPartnerId: 'rail-secret-partner',
    amountSource: 100,
    feeSource: 2.99,
    totalChargeSource: 102.99,
    ...over,
  };
}

function deps(over: Partial<CustomerSummarizerDeps> = {}): CustomerSummarizerDeps {
  return {
    redis: fakeRedis(),
    store: { listTransfersByPhone: async () => [transfer()] },
    customers: { getCustomer: async () => customer() },
    partners: {
      getPartner: async () => partner(),
      ensureDefaultPartner: async () => partner(),
    },
    dailyVolume: { getTodayCents: async () => 0 },
    chatFn: vi.fn(async (): Promise<ChatMessage> => ({ role: 'assistant', content: 'A summary.' })),
    ...over,
  };
}

describe('buildSummaryContext', () => {
  it('projects ONLY safe, own-customer facts — never routing/compliance/destination/phone fields', () => {
    const ctx = buildSummaryContext(customer(), [transfer()], 0, true);
    const json = JSON.stringify(ctx);

    expect(ctx.recentTransfers).toEqual([
      { id: 'tr_1', recipient: 'Mom', amount: 100, currency: 'USD', status: 'delivered', refund: 'none' },
    ]);
    // Guardrails: none of these may EVER enter the prompt context.
    expect(json).not.toContain('rail-secret-partner'); // settlementPartnerId
    expect(json).not.toContain('sanctions');           // complianceReasons
    expect(json).not.toContain('4242');                // payout destination (even masked)
    expect(json).not.toContain('543210');              // recipient phone
    expect(json).not.toContain(PHONE);                 // the sender's own number
  });

  it('derives tier + remaining daily limit the same way check_send_limit does', () => {
    // Verified, past the 3-day window, gate on ⇒ T1 ($2,999/day); $500 used.
    const ctx = buildSummaryContext(customer(), [], 50_000, true);
    expect(ctx.tier).toBe('T1');
    expect(ctx.dailyLimitUsd).toBe(2999);
    expect(ctx.dailyRemainingUsd).toBe(2499);
  });

  it('counts only in-flight refunds as pending and overlays refund state per transfer', () => {
    const ctx = buildSummaryContext(
      customer(),
      [
        transfer({ id: 'tr_a', refundStatus: 'requested' }),
        transfer({ id: 'tr_b', refundStatus: 'pending' }),
        transfer({ id: 'tr_c', refundStatus: 'completed' }),
        transfer({ id: 'tr_d', refundStatus: 'failed' }),
        transfer({ id: 'tr_e' }),
      ],
      0,
      true,
    );
    expect(ctx.pendingRefunds).toBe(2); // requested + pending only
    expect(ctx.recentTransfers.map((t) => t.refund)).toEqual([
      'requested', 'pending', 'completed', 'failed', 'none',
    ]);
  });

  it('caps the context at the 5 most recent transfers', () => {
    const six = Array.from({ length: 6 }, (_, i) => transfer({ id: `tr_${i}` }));
    const ctx = buildSummaryContext(customer(), six, 0, true);
    expect(ctx.recentTransfers).toHaveLength(5);
  });
});

describe('buildDeterministicSummary', () => {
  it('returns non-empty plain text from a populated context', () => {
    const ctx = buildSummaryContext(
      customer(),
      [transfer({ id: 'tr_a', status: 'paid' })],
      0,
      true,
    );
    const out = buildDeterministicSummary(ctx);
    expect(out.length).toBeGreaterThan(0);
    expect(typeof out).toBe('string');
    // Plain text only — no markdown bullets, no JSON braces leaking through.
    expect(out).not.toContain('{');
    expect(out).not.toMatch(/^[-*]/m);
  });

  it('never throws and is non-empty on a totally empty account', () => {
    const ctx = buildSummaryContext(customer(), [], 0, true);
    let out = '';
    expect(() => {
      out = buildDeterministicSummary(ctx);
    }).not.toThrow();
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('mentions pending refunds when there are any', () => {
    const ctx = buildSummaryContext(
      customer(),
      [transfer({ id: 'r1', status: 'paid', refundStatus: 'requested' })],
      0,
      true,
    );
    const out = buildDeterministicSummary(ctx);
    expect(out.toLowerCase()).toContain('refund');
  });

  it('never leaks routing / compliance / destination / phone facts', () => {
    const ctx = buildSummaryContext(customer(), [transfer({ status: 'paid' })], 0, true);
    const out = buildDeterministicSummary(ctx);
    expect(out).not.toContain('rail-secret-partner');
    expect(out).not.toContain('4242');
    expect(out).not.toContain('543210');
    expect(out).not.toContain(PHONE);
  });
});

describe('getCustomerSummary', () => {
  it('serves the cached summary and never calls the model (cache hit)', async () => {
    const redis = fakeRedis();
    await redis.set(`summary:${PHONE}`, 'cached summary', { ex: 86400 });
    const chatFn = vi.fn();
    const s = createCustomerSummarizer(deps({ redis, chatFn }));

    expect(await s.getCustomerSummary(PHONE)).toBe('cached summary');
    expect(chatFn).not.toHaveBeenCalled();
  });

  it('one-shot chat on a cache miss: pinned system prompt, NO tools, result cached 24h', async () => {
    const redis = fakeRedis();
    const chatFn = vi.fn(
      async (_messages: ChatMessage[], _tools: ChatTool[]): Promise<ChatMessage> => ({
        role: 'assistant',
        content: '  You sent 100 USD to Mom and it was delivered.  ',
      }),
    );
    const s = createCustomerSummarizer(deps({ redis, chatFn }));

    const out = await s.getCustomerSummary(PHONE);
    expect(out).toBe('You sent 100 USD to Mom and it was delivered.');
    expect(chatFn).toHaveBeenCalledTimes(1);

    const [messages, tools] = chatFn.mock.calls[0];
    expect(tools).toEqual([]); // no tools, no agent loop
    expect(messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM_PROMPT });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Mom');
    expect(messages[1].content).not.toContain('rail-secret-partner');

    // Cached as a PLAIN STRING (automaticDeserialization:false contract) …
    expect(await redis.get(`summary:${PHONE}`)).toBe(out);
    // … so the next call never re-hits the model.
    await s.getCustomerSummary(PHONE);
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('returns null when the model throws — and caches nothing', async () => {
    const redis = fakeRedis();
    const chatFn = vi.fn(async (): Promise<ChatMessage> => {
      throw new Error('Ollama request failed (500): boom');
    });
    const s = createCustomerSummarizer(deps({ redis, chatFn }));

    expect(await s.getCustomerSummary(PHONE)).toBeNull();
    expect(await redis.get(`summary:${PHONE}`)).toBeNull();
  });

  it('returns null when the model hangs past the timeout', async () => {
    const chatFn = vi.fn(() => new Promise<ChatMessage>(() => {})); // never settles
    const s = createCustomerSummarizer(deps({ chatFn, timeoutMs: 25 }));
    expect(await s.getCustomerSummary(PHONE)).toBeNull();
  });

  it('returns null on an empty/None model reply', async () => {
    const chatFn = vi.fn(async (): Promise<ChatMessage> => ({ role: 'assistant', content: null }));
    const s = createCustomerSummarizer(deps({ chatFn }));
    expect(await s.getCustomerSummary(PHONE)).toBeNull();
  });

  it('returns null for an unknown customer without calling the model', async () => {
    const chatFn = vi.fn();
    const s = createCustomerSummarizer(
      deps({ customers: { getCustomer: async () => null }, chatFn }),
    );
    expect(await s.getCustomerSummary(PHONE)).toBeNull();
    expect(chatFn).not.toHaveBeenCalled();
  });
});

describe('SUMMARY_SYSTEM_PROMPT — guardrails pinned', () => {
  it('asks for 2-3 plain-language sentences', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('2-3');
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('plain language');
  });
  it('forbids financial advice', () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('no financial advice');
  });
  it('forbids promises/guarantees', () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('no promises');
  });
  it('forbids inventing numbers not in the context', () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('never invent');
  });
  it('forbids compliance detail', () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('no compliance detail');
  });
});
