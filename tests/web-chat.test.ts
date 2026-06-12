import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebChat, webThreadStore, webThreadPhone } from '@/lib/web-chat';
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
import type { ChatMessage, Customer } from '@/lib/types';
import type { Db } from '@/db/client';

// web-chat (B5) — the dashboard chat thread is keyed conv:web:<phone>, fully
// separate from the WhatsApp thread at conv:<phone>; the agent runs with the
// 'web' channel so non-allowlisted tools can never execute from the dashboard.

let db: Db;

const PHONE = '15551234567';

function customerFixture(phone = PHONE): Customer {
  const nowIso = new Date().toISOString();
  return {
    senderPhone: phone,
    firstSeenAt: nowIso,
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: nowIso,
    updatedAt: nowIso,
  } as Customer;
}

function buildDeps(redis = fakeRedis()) {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  return {
    redis,
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(redis),
    monthlyVolumeStore: createMonthlyVolumeStore(redis),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webThreadStore', () => {
  it('reads/writes conversations at conv:web:<phone>, leaving conv:<phone> untouched', async () => {
    const { redis, store } = buildDeps();
    // A live WhatsApp thread at the plain key.
    await store.saveConversation(PHONE, [{ role: 'user', content: 'wa message' }]);

    const web = webThreadStore(store);
    await web.saveConversation(PHONE, [{ role: 'user', content: 'web message' }]);

    expect(redis.dump.has(`conv:${PHONE}`)).toBe(true);
    expect(redis.dump.has(`conv:web:${PHONE}`)).toBe(true);
    // The WhatsApp thread is byte-for-byte untouched.
    expect(JSON.parse(redis.dump.get(`conv:${PHONE}`)!)).toEqual([
      { role: 'user', content: 'wa message' },
    ]);
    expect(await web.getConversation(PHONE)).toEqual([{ role: 'user', content: 'web message' }]);
    // …and the plain read still sees only the WhatsApp thread.
    expect(await store.getConversation(PHONE)).toEqual([{ role: 'user', content: 'wa message' }]);
  });

  it('saves with the same 30-day TTL as WhatsApp threads', async () => {
    const { redis, store } = buildDeps();
    const setSpy = vi.spyOn(redis, 'set');
    await webThreadStore(store).saveConversation(PHONE, [{ role: 'user', content: 'hi' }]);
    expect(setSpy).toHaveBeenCalledWith(
      `conv:web:${PHONE}`,
      expect.any(String),
      { ex: 30 * 24 * 3600 },
    );
  });

  it('trims to 40 messages on save, exactly like WhatsApp threads', async () => {
    const { store } = buildDeps();
    const web = webThreadStore(store);
    const long: ChatMessage[] = [];
    for (let i = 0; i < 45; i++) {
      long.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
    }
    await web.saveConversation(PHONE, long);
    const back = await web.getConversation(PHONE);
    expect(back.length).toBeLessThanOrEqual(40);
    expect(back[0].role).toBe('user'); // trim re-anchors on a user message
    expect(back[back.length - 1].content).toBe('m44'); // newest kept
  });

  it('delegates non-conversation methods to the same underlying ledger', async () => {
    const { store } = buildDeps();
    const web = webThreadStore(store);
    await web.upsertRecipient(PHONE, {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi',
      payoutDestination: 'mom@upi', lastUsedAt: new Date().toISOString(),
    });
    // Visible through the base store — one ledger, no key-space fork.
    expect((await store.listRecipients(PHONE, 5)).map((r) => r.name)).toEqual(['Mom']);
  });
});

describe('createWebChat', () => {
  it('runs a turn on the web thread; the WhatsApp thread never changes', async () => {
    const deps = buildDeps();
    await deps.store.saveConversation(PHONE, [{ role: 'user', content: 'wa history' }]);

    const webChat = createWebChat({
      ...deps,
      chat: async () => ({ role: 'assistant', content: 'Hello from the dashboard!' }),
    });
    const reply = await webChat.runTurn(customerFixture(), 'hi there');
    expect(reply).toBe('Hello from the dashboard!');

    // Web thread persisted under its own key…
    const webConv = JSON.parse(deps.redis.dump.get(`conv:web:${PHONE}`)!) as ChatMessage[];
    expect(webConv.some((m) => m.role === 'user' && m.content === 'hi there')).toBe(true);
    // …while the WhatsApp thread is untouched.
    expect(await deps.store.getConversation(PHONE)).toEqual([
      { role: 'user', content: 'wa history' },
    ]);
  });

  it('derives isNewConversation from web-thread emptiness (first turn yes, second no)', async () => {
    const deps = buildDeps();
    const seen: ChatMessage[][] = [];
    const webChat = createWebChat({
      ...deps,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    // Match the injected NOTE by its body text ('first message in over 24 hours')
    // — the bare '[NEW CONVERSATION]' tag also appears inside the base prompt.
    await webChat.runTurn(customerFixture(), 'first');
    const sys1 = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys1).toContain('First message in over 24 hours');

    await webChat.runTurn(customerFixture(), 'second');
    const sys2 = seen[1].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys2).not.toContain('First message in over 24 hours');
  });

  it('a pre-existing WhatsApp thread does NOT suppress the web [NEW CONVERSATION]', async () => {
    const deps = buildDeps();
    await deps.store.saveConversation(PHONE, [
      { role: 'user', content: 'old wa chat' },
      { role: 'assistant', content: 'old wa reply' },
    ]);
    const seen: ChatMessage[][] = [];
    const webChat = createWebChat({
      ...deps,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await webChat.runTurn(customerFixture(), 'hello web');
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('First message in over 24 hours'); // separate thread ⇒ separate freshness
    // The WhatsApp history is NOT in the model's context.
    expect(seen[0].some((m) => m.content === 'old wa chat')).toBe(false);
  });

  it('runs on the web channel: a scripted blocked tool call creates no draft', async () => {
    const deps = buildDeps();
    const createDraft = vi.spyOn(deps.draftStore, 'createDraft');
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
      { role: 'assistant', content: 'I cannot do that from here.' },
    ];
    let i = 0;
    const webChat = createWebChat({ ...deps, chat: async () => responses[i++] });
    const reply = await webChat.runTurn(customerFixture(), 'send $100 to Mom');
    expect(reply).toBe('I cannot do that from here.');
    expect(createDraft).not.toHaveBeenCalled();
    // The dispatch-level refusal is what the model saw.
    const conv = JSON.parse(deps.redis.dump.get(`conv:web:${PHONE}`)!) as ChatMessage[];
    expect(conv.find((m) => m.role === 'tool')!.content).toContain('not available here');
  });

  it('the web [WEB CHAT] channel note is injected on every web turn', async () => {
    const deps = buildDeps();
    const seen: ChatMessage[][] = [];
    const webChat = createWebChat({
      ...deps,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await webChat.runTurn(customerFixture(), 'hello');
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('[WEB CHAT]');
  });
});

describe('webThreadPhone', () => {
  it('prefixes the phone so the store key becomes conv:web:<phone>', () => {
    expect(webThreadPhone('15551234567')).toBe('web:15551234567');
  });
});
