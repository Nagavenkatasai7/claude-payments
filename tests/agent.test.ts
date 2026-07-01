import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage } from '@/lib/types';
import type { Db } from '@/db/client';

// Mock @/db/client so the Neon WebSocket driver (+ ws) is never loaded in this
// test process — these are the modules responsible for the 12 GB heap footprint
// that OOMs the 7 GB CI runner. getDb() returns the PGlite instance set each
// beforeEach so tools that call getDb() get the real in-process Postgres.
const _dbProxy = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/db/client', () => ({ getDb: () => _dbProxy.current }));

// selectSettlementRoute is mocked to return a fixed mid-rate so tests don't
// depend on live FX routing logic.
vi.mock('@/lib/partner-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/partner-rates')>()),
  selectSettlementRoute: vi.fn(
    async (_db: unknown, _integrations: unknown, _s: unknown, _d: unknown, mid: number) =>
      ({ fxRate: mid, source: 'platform' as const }),
  ),
}));

// Partner store is pg-backed (Stage 2a cutover): freshDb() truncates the shared
// PGlite and reseeds the 'default' partner, so it runs per-test in beforeEach.
let db: Db;

function extraDeps(redis = fakeRedis(), store = createStore(redis, db)) {
  const customerStore = createCustomerStore(db, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  const partnerStore = createPartnerStore(db);
  return { customerStore, dailyVolumeStore, monthlyVolumeStore, kycProvider, partnerStore };
}

// Schedules are pg-backed now — the redis arg is gone; accept (and ignore) the
// legacy call-site shape to keep the diff minimal.
function freshScheduleStore(_redis = fakeRedis()) {
  return createScheduleStore(db);
}

const PHONE = '15551234567';

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  _dbProxy.current = db;
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
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...extraDeps(redis, store),
      chat: async () => ({ role: 'assistant', content: 'Hi there!' }),
    });
    const reply = await agent.runAgentTurn(PHONE, 'hello');
    expect(reply).toBe('Hi there!');
  });

  it('appends the canonical kyc_url on a verify hand-off (model-emitted URLs are stripped)', async () => {
    // Regression: an unverified sender hits the verify-before-send gate; the model
    // writes a "verify here 👉" message, but sanitizeReply strips ALL model URLs —
    // so the real kyc_url (code-generated) must be COLLECTED + appended by us, else
    // the customer gets a 👉 with no link.
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    // Gate is partner OPT-IN now — the verify hand-off (and the appended
    // kyc_url) only exists when it's ON. Gate-off suppression has its own test.
    await deps.partnerStore.savePartner({ ...(await deps.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_send_limit', arguments: JSON.stringify({ amount_usd: 500 }) } }],
      },
      { role: 'assistant', content: 'Before I can send that, verify your identity here: 👉 https://model-made-up.example/foo' },
    ];
    let i = 0;
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'send $500 to Mom');
    expect(reply).not.toContain('model-made-up.example'); // model's invented URL stripped
    expect(reply).toContain(`https://example.com/admin-dashboard/customers/${PHONE}`); // canonical kyc_url appended
  });

  it('gate OFF: no verify link is ever appended, even when the model writes a verify-style reply', async () => {
    // QA audit regression: the default partner has NOT opted into
    // verify-before-send, so neither the tools nor the agent may surface a
    // kyc_url — the reply must carry no link at all.
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_send_limit', arguments: JSON.stringify({ amount_usd: 5000 }) } }],
      },
      { role: 'assistant', content: 'That is over your limit — verify here: 👉 https://model-made-up.example/foo' },
    ];
    let i = 0;
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'send $5000 to Mom');
    expect(reply).not.toContain('model-made-up.example');
    expect(reply).not.toContain('admin-dashboard/customers'); // no canonical kyc_url either
    expect(reply).not.toContain('https://'); // no link of any kind
  });

  it('DETERMINISTIC backstop: delivers the verify link on "resend" even when the model calls NO tool', async () => {
    // The exact bug: on "resend the verify link" the model answers from history
    // with NO tool call, pasting a stale URL. sanitizeReply strips it → blank 👉.
    // The backstop must mint + append the canonical link with zero tool calls.
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    // Gate is partner OPT-IN now — these verify-flow paths need it ON.
    await deps.partnerStore.savePartner({ ...(await deps.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      // Single plain-text reply, NO tool_calls — the model echoing a stale link.
      chat: async () => ({
        role: 'assistant',
        content: 'Sure! Here is your verification link again 👉 https://stale-from-history.example/x',
      }),
    });
    const reply = await agent.runAgentTurn(PHONE, 'resend the verify link');
    expect(reply).not.toContain('stale-from-history.example'); // model's echoed URL stripped
    expect(reply).toContain(`https://example.com/admin-dashboard/customers/${PHONE}`); // canonical link appended by the backstop
  });

  it('backstop does NOT fire for a verified customer (no spurious verify link)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      chat: async () => ({ role: 'assistant', content: "You're all set — your identity is verified!" }),
    });
    const reply = await agent.runAgentTurn(PHONE, 'am I verified?');
    expect(reply).toBe("You're all set — your identity is verified!");
    expect(reply).not.toContain('/admin-dashboard/customers/'); // no link appended
  });

  it('graceful error: a chat() failure returns the fallback line AND preserves history', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...extraDeps(redis, store),
      chat: async () => { throw new Error('Ollama request failed (503)'); }, // throws on both the call and its retry
    });
    const reply = await agent.runAgentTurn(PHONE, 'hello');
    expect(reply).toBe("Sorry, I'm having trouble right now. Could you send that again?");
    // History (the inbound message) must be saved so the customer can resend
    // without losing context — not dropped by the error path.
    const saved = await store.getConversation(PHONE);
    expect(saved.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
  });

  it('chat() retry: a single transient failure self-heals and returns the real reply', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    let calls = 0;
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...extraDeps(redis, store),
      chat: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Ollama request failed (502)');
        return { role: 'assistant', content: 'Back online — how can I help?' };
      },
    });
    const reply = await agent.runAgentTurn(PHONE, 'hello');
    expect(reply).toBe('Back online — how can I help?');
    expect(calls).toBe(2); // failed once, retried once
  });

  it('injects the [UNVERIFIED SENDER] guard note for an unverified customer', async () => {
    // Regression: an unverified sender said "send money" and the bot asked "how much?"
    // instead of leading with verification. The deterministic note must be present so
    // the model leads with the verify link, not the amount.
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    // Gate is partner OPT-IN now — these verify-flow paths need it ON.
    await deps.partnerStore.savePartner({ ...(await deps.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    let captured: ChatMessage[] = [];
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      chat: async (messages) => { captured = messages; return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn(PHONE, 'I want to send money to my mom in India');
    const sys = captured.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('[UNVERIFIED SENDER]');
  });

  it('does NOT inject the [UNVERIFIED SENDER] note for a verified customer', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    let captured: ChatMessage[] = [];
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...deps,
      chat: async (messages) => { captured = messages; return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn(PHONE, 'I want to send money to my mom in India');
    const sys = captured.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).not.toContain('[UNVERIFIED SENDER]');
  });

  it('executes a tool call, then returns the follow-up reply', async () => {
    const store = createStore(fakeRedis(), db);
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
    const deps = extraDeps(fakeRedis(), store);
    // Phase 3: a verified sender so get_quote returns a quote (not a kyc_required gate).
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...deps,
      chat: async () => responses[call++],
    });

    const reply = await agent.runAgentTurn(PHONE, 'send $500 via upi');
    expect(reply).toBe('You send $500, they get a lot of INR.');

    const conv = await store.getConversation(PHONE);
    expect(conv.some((m) => m.role === 'tool')).toBe(true);
  });

  it('saves the conversation history after a turn', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...extraDeps(redis, store),
      chat: async () => ({ role: 'assistant', content: 'noted' }),
    });
    await agent.runAgentTurn(PHONE, 'remember this');
    const conv = await store.getConversation(PHONE);
    expect(conv[0]).toEqual({ role: 'user', content: 'remember this' });
  });

  it('replaces a typo URL in the model reply with the canonical payment link', async () => {
    const store = createStore(fakeRedis(), db);
    // The canonical URL is code-generated from APP_BASE_URL (https://smartremit.test in tests).
    const canonicalUrl = 'https://smartremit.test/pay/abc123';
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
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      partnerId: 'default',
      amountSource: 100,
      feeSource: 1.99,
      totalChargeSource: 101.99,
    });

    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...extraDeps(fakeRedis(), store),
      chat: async () => responses[call++],
    });

    const reply = await agent.runAgentTurn(PHONE, 'pay now');

    // The returned string must contain the canonical URL
    expect(reply).toContain(canonicalUrl);
    // The returned string must NOT contain the typo domain
    expect(reply).not.toMatch(/verce\.app/);
  });

  it('keeps the raw model message in conversation history (unsanitized)', async () => {
    const store = createStore(fakeRedis(), db);
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
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      partnerId: 'default',
      amountSource: 100,
      feeSource: 1.99,
      totalChargeSource: 101.99,
    });

    let call = 0;
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...extraDeps(fakeRedis(), store),
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

describe('createAgent — web history link (list_recent_transfers)', () => {
  const seedVerified = async (deps: ReturnType<typeof extraDeps>) => {
    const now = new Date().toISOString();
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
      partnerId: 'default', optInAt: now, createdAt: now, updatedAt: now,
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
  };

  it('appends the canonical history link when no pay/verify link was produced', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedVerified(deps);
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_recent_transfers', arguments: '{}' } }],
      },
      { role: 'assistant', content: 'Here are your recent sends. 👉 https://model-made-up.example/x' },
    ];
    let i = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, channel: 'web', chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'show my recent transactions');
    expect(reply).not.toContain('model-made-up.example'); // model URL stripped
    expect(reply).toContain('https://smartremit.test/account/history'); // code link appended
  });

  it('a pay link ALWAYS wins the single append slot over the history link', async () => {
    // Regression: history_url must never displace a pay link, even when
    // list_recent_transfers is the LATER tool call in the same turn (the order
    // that would overwrite the pay link if both shared the append array).
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedVerified(deps);
    const now = new Date().toISOString();
    await store.saveTransfer({
      id: 'pay123', phone: PHONE, amountUsd: 100, feeUsd: 2, totalChargeUsd: 102, fxRate: 85,
      amountInr: 8500, recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi',
      payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
      complianceReasons: [], status: 'awaiting_payment', createdAt: now, partnerId: 'default',
      sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      amountSource: 100, feeSource: 2, totalChargeSource: 102,
    } as never);
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'generate_payment_link', arguments: JSON.stringify({ transfer_id: 'pay123' }) } },
          { id: 'c2', type: 'function', function: { name: 'list_recent_transfers', arguments: '{}' } },
        ],
      },
      { role: 'assistant', content: 'Your recent sends, and the payment link for that transfer.' },
    ];
    let i = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, channel: 'web', chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'pay link for pay123 and show my recent sends');
    expect(reply).toContain('https://smartremit.test/pay/pay123'); // pay link wins
    expect(reply).not.toContain('/account/history'); // history link suppressed this turn
  });
});

