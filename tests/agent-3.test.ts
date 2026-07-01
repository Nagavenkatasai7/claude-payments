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
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { selectSettlementRoute } from '@/lib/partner-rates';
import type { ChatMessage, TurnContext } from '@/lib/types';
import type { Db } from '@/db/client';

// Best-rate routing (B2): the agent wires the LIVE route selector into the
// tool ctx — `selectSettlementRoute(getDb(), …)`. getDb() dials the dud test
// DATABASE_URL, so the module is mocked file-wide; the default impl returns
// the platform route (mid), which is byte-identical to no routing for every
// pre-existing test. The wiring suite overrides per-test.
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

describe('createAgent — [NEW CUSTOMER] and [TIER_REMINDER] notes', () => {
  function build(redis = fakeRedis()) {
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const partnerStore = createPartnerStore(db);
    return { redis, store, customerStore, dailyVolumeStore, monthlyVolumeStore, kycProvider, partnerStore };
  }

  it('prepends [NEW CUSTOMER] when turn.isNewCustomer is true', async () => {
    const b = build();
    // Gate is partner OPT-IN now — these verify-flow paths need it ON.
    await b.partnerStore.savePartner({ ...(await b.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: freshScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      monthlyVolumeStore: b.monthlyVolumeStore,
      kycProvider: b.kycProvider,
      partnerStore: b.partnerStore,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', { isNewConversation: true, isNewCustomer: true });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && s.includes('first message ever from this phone'))).toBe(true);
  });

  it('prepends [TIER_REMINDER day 2/3] when turn.tierReminderDayOfWindow is 2', async () => {
    const b = build();
    // Gate is partner OPT-IN now — these verify-flow paths need it ON.
    await b.partnerStore.savePartner({ ...(await b.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: freshScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      monthlyVolumeStore: b.monthlyVolumeStore,
      kycProvider: b.kycProvider,
      partnerStore: b.partnerStore,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', {
      isNewConversation: true,
      tierReminderDayOfWindow: 2,
    });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && s.includes('T0 customer in their observation window') && s.includes('day 2/3'))).toBe(true);
  });

  it('does NOT prepend either when neither flag is set', async () => {
    const b = build();
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: freshScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      monthlyVolumeStore: b.monthlyVolumeStore,
      kycProvider: b.kycProvider,
      partnerStore: b.partnerStore,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', { isNewConversation: false });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && (
      s.includes('first message ever from this phone') ||
      s.includes('T0 customer in their observation window')
    ))).toBe(false);
  });
});

describe('createAgent — bug fixes (crash-safety, recipient-tap, no double message)', () => {
  it('a thrown tool degrades to a model-visible error instead of crashing the turn', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    store.getTransferCount = async () => { throw new Error('boom'); }; // force get_quote to throw
    let round = 0;
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(),
      draftStore: createDraftStore(fakeRedis()),
      ...extraDeps(redis, store),
      chat: async () => {
        round++;
        if (round === 1) {
          return { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_quote', arguments: '{"amount_usd":100,"funding_method":"bank_transfer"}' } }] };
        }
        return { role: 'assistant', content: 'Sorry, let me try that again.' };
      },
    });
    // Must RESOLVE (not reject) even though the tool threw.
    const reply = await agent.runAgentTurn(PHONE, 'send 100');
    expect(reply).toBe('Sorry, let me try that again.');
  });

  it('injects [RECIPIENT SELECTED] with full details on a recipient button tap', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.upsertRecipient(PHONE, { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@okhdfc', lastUsedAt: new Date().toISOString() });
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(), draftStore: createDraftStore(fakeRedis()), ...extraDeps(redis, store),
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'How much?' }; },
    });
    const turn: TurnContext = { isNewConversation: false, buttonTap: { kind: 'recipient', recipientPhone: '919876543210' } };
    await agent.runAgentTurn(PHONE, '[Tapped: Send to recipient 919876543210]', turn);
    // Match the INJECTED note by its data (the SYSTEM_PROMPT also mentions the tag as guidance).
    const note = seen[0].filter((m) => m.role === 'system').map((m) => m.content as string).find((s) => s.includes('payout_destination=mom@okhdfc'));
    expect(note).toBeDefined();
    expect(note).toContain('[RECIPIENT SELECTED]');
    expect(note).toContain('name=Mom');
  });

  it('suppresses the trailing text when a tool sent an interactive (no double message)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.upsertRecipient(PHONE, { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@okhdfc', lastUsedAt: new Date().toISOString() });
    let round = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(), draftStore: createDraftStore(fakeRedis()), ...extraDeps(redis, store),
      chat: async () => {
        round++;
        if (round === 1) {
          return { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'send_recipient_picker', arguments: JSON.stringify({ recipients: [{ name: 'Mom', recipient_phone: '919876543210' }] }) } }] };
        }
        return { role: 'assistant', content: "I've sent you a picker — tap who!" };
      },
    });
    const reply = await agent.runAgentTurn(PHONE, 'send money');
    expect(reply).toBe(''); // the picker card IS the message; trailing text suppressed
  });
});

describe('best-rate routing wiring (B2)', () => {
  // The agent must hand the tools a LIVE routeSelector that consults
  // selectSettlementRoute (mocked file-wide; see the vi.mock at the top).

  async function seedVerified(deps: ReturnType<typeof extraDeps>, phone: string, partnerId = 'default') {
    const nowIso = new Date().toISOString();
    await deps.customerStore.saveCustomer({
      senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
      senderCountry: 'US', partnerId, optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
  }

  function quoteScript(): { responses: ChatMessage[]; next: () => ChatMessage } {
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_quote', arguments: JSON.stringify({ amount_usd: 100, funding_method: 'bank_transfer' }) } }],
      },
      { role: 'assistant', content: 'Here is your quote!' },
    ];
    let i = 0;
    return { responses, next: () => responses[i++] };
  }

  it('default tenant: get_quote consults the wired selector with the mid rate and applies the winning route', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedVerified(deps, PHONE);
    vi.mocked(selectSettlementRoute).mockClear();
    vi.mocked(selectSettlementRoute).mockResolvedValueOnce({
      fxRate: 86, source: 'partner', settlementPartnerId: 'rail-partner-x',
    });
    const script = quoteScript();
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, chat: async () => script.next(),
    });
    const reply = await agent.runAgentTurn(PHONE, 'how much to send $100?');
    expect(reply).toBe('Here is your quote!');
    // The LIVE selector was consulted with this corridor + the mid cross-rate.
    expect(vi.mocked(selectSettlementRoute)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(selectSettlementRoute)).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'USD', 'INR', 85.2,
    );
    // The tool result the model saw quotes the WINNING rate — and leaks no partner id.
    const history = await store.getConversation(PHONE);
    const toolMsg = history.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const result = JSON.parse(toolMsg!.content!) as Record<string, unknown>;
    expect(result.fx_rate).toBe(86);
    expect(result.amount_inr).toBe(Math.round(100 * 86));
    expect(toolMsg!.content).not.toContain('rail-partner-x');
  });

  it('white-label tenant: the wired selector is NEVER consulted; the quote stays at mid', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedPartner(db, 'acme');
    await seedVerified(deps, PHONE, 'acme');
    vi.mocked(selectSettlementRoute).mockClear();
    const script = quoteScript();
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, chat: async () => script.next(),
    });
    await agent.runAgentTurn(PHONE, 'how much to send $100?');
    expect(vi.mocked(selectSettlementRoute)).not.toHaveBeenCalled();
    const history = await store.getConversation(PHONE);
    const toolMsg = history.find((m) => m.role === 'tool');
    const result = JSON.parse(toolMsg!.content!) as Record<string, unknown>;
    expect(result.fx_rate).toBe(85.2); // pinned to the partner at mid
  });
});

describe('web channel (B5) — schemas, dispatch, note, links', () => {
  const seedVerifiedCustomer = async (deps: ReturnType<typeof extraDeps>) => {
    const nowIso = new Date().toISOString();
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
  };

  it("channel 'web': the model is shown ONLY allowlisted tool schemas", async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    let seenTools: import('@/lib/types').ChatTool[] = [];
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...extraDeps(redis, store),
      channel: 'web',
      chat: async (_messages, tools) => { seenTools = tools; return { role: 'assistant', content: 'hi' }; },
    });
    await agent.runAgentTurn(PHONE, 'hello');
    const names = seenTools.map((t) => t.function.name);
    expect(names).toContain('get_quote');
    expect(names).toContain('request_refund');
    expect(names).toContain('repeat_transfer');
    expect(names).not.toContain('create_transfer');
    expect(names).not.toContain('send_approve_picker');
    expect(names).not.toContain('send_recipient_picker');
    expect(names).not.toContain('create_schedule');
    expect(names).toContain('open_recall_dispute');
    expect(names).toContain('list_recent_transfers'); // web-only history lookup
    expect(names).toHaveLength(12);
  });

  it('default channel: the model still sees the full WhatsApp tool set (call sites unchanged)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    let seenTools: import('@/lib/types').ChatTool[] = [];
    const agent = createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...extraDeps(redis, store),
      chat: async (_messages, tools) => { seenTools = tools; return { role: 'assistant', content: 'hi' }; },
    });
    await agent.runAgentTurn(PHONE, 'hello');
    expect(seenTools).toHaveLength(25);
    const dn = seenTools.map((t) => t.function.name);
    expect(dn).toContain('send_approve_picker');
    expect(dn).toContain('present_bill'); // B2B — WhatsApp channel
    expect(dn).toContain('register_seller'); // cross-border seller onboarding — WhatsApp channel
    expect(dn).toContain('create_invoice'); // cross-border seller billing — WhatsApp channel
    expect(dn).toContain('cancel_bill'); // B2B lifecycle (L1) — WhatsApp channel
    expect(dn).toContain('check_bill_status'); // B2B lifecycle (L1) — WhatsApp channel
    expect(dn).toContain('dispute_bill'); // B2B lifecycle (L1) — WhatsApp channel
    expect(dn).not.toContain('list_recent_transfers'); // web-only — never on WhatsApp
  });

  it("channel 'web': injects the [WEB CHAT] note; default channel does not", async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const seen: ChatMessage[][] = [];
    const mk = (channel?: 'web') => createAgent({
      store,
      scheduleStore: freshScheduleStore(redis),
      draftStore: createDraftStore(redis),
      ...extraDeps(redis, store),
      ...(channel ? { channel } : {}),
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await mk('web').runAgentTurn(PHONE, 'hello');
    const webSys = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(webSys).toContain('[WEB CHAT]');

    seen.length = 0;
    await mk().runAgentTurn(PHONE, 'hello');
    const waSys = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(waSys).not.toContain('[WEB CHAT]');
  });

  it('a scripted model calling a BLOCKED tool on web degrades gracefully and mints nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedVerifiedCustomer(deps);
    const draftStore = createDraftStore(redis);
    const createDraft = vi.spyOn(draftStore, 'createDraft');
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: {
            name: 'send_approve_picker',
            arguments: JSON.stringify({ amount_usd: 100, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: '919876543210' }),
          },
        }],
      },
      { role: 'assistant', content: 'Sorry — I can\'t do that here. You can finish that in WhatsApp.' },
    ];
    let i = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore,
      ...deps, channel: 'web', chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'send $100 to Mom');
    expect(reply).toContain("can't do that here");
    // The blocked attempt fed the model a flat error and performed NO side effect.
    const conv = await store.getConversation(PHONE);
    const toolMsg = conv.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('not available here');
    expect(createDraft).not.toHaveBeenCalled();
    expect(await store.listTransfers()).toHaveLength(0);
  });

  it('web repeat_transfer: the canonical pay link is appended; model URLs are stripped', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await seedVerifiedCustomer(deps);
    // A past delivered send + the saved recipient (the repeat hydrates from these).
    await store.saveTransfer({
      id: 'tx-past-1', phone: PHONE, amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99,
      fxRate: 85.2, amountInr: 17040, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@okhdfc', fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
      createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
      destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
      amountSource: 200, feeSource: 1.99, totalChargeSource: 201.99,
    });
    await store.upsertRecipient(PHONE, {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi',
      payoutDestination: 'mom@okhdfc', lastUsedAt: new Date().toISOString(),
    });
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'repeat_transfer', arguments: JSON.stringify({ recipient_phone: '919876543210' }) },
        }],
      },
      { role: 'assistant', content: 'All set — pay here: https://model-made-up.example/pay/x' },
    ];
    let i = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, channel: 'web', chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'send Mom the usual');
    expect(reply).not.toContain('model-made-up.example'); // model URL stripped
    expect(reply).toMatch(/https:\/\/smartremit\.test\/pay\/\S+/); // canonical pay link appended
  });

  it('web channel: the kyc_url verify backstop keeps working (links render as links)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'not_started',
      senderCountry: 'US', partnerId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof deps.customerStore.saveCustomer>[0]);
    await deps.partnerStore.savePartner({ ...(await deps.partnerStore.ensureDefaultPartner()), requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const responses: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_send_limit', arguments: JSON.stringify({ amount_usd: 500 }) } }],
      },
      { role: 'assistant', content: 'Please verify your identity first: 👉 https://model-made-up.example/foo' },
    ];
    let i = 0;
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis),
      ...deps, channel: 'web', chat: async () => responses[i++],
    });
    const reply = await agent.runAgentTurn(PHONE, 'send $500 to Mom');
    expect(reply).not.toContain('model-made-up.example');
    expect(reply).toContain(`https://example.com/admin-dashboard/customers/${PHONE}`);
  });
});
