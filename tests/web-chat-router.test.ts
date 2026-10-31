import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createWebChat } from '@/lib/web-chat';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { aiNoticeText } from '@/lib/ai-notice';
import { AI_NOTICE_ACTION } from '@/lib/ai-notice-marker';
import { OFF_TOPIC_REPLY } from '@/lib/scope-guard';
import { helpIntentReply } from '@/lib/help-intents';
import { pausedReply } from '@/lib/turn-router';
import { FALLBACK_REPLY } from '@/lib/agent-fallback';
import type { Customer, Transfer } from '@/lib/types';
import type { Db } from '@/db/client';

// The web chat runs no outbox turn, so it runs the SAME router itself (PR1):
// paused (R26 slot) → HELP (R43) → off-topic (R56) → the model, and every reply
// carries the AI notice (R17) when the durable web marker says it is due.

let db: Db;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
const events = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('@/lib/outbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/outbox')>()),
  pokeWorker: () => {
    events.list.push('poke');
  },
}));

const PHONE = '15551234568';
const NOTICE_WEB = aiNoticeText('en', 'web');

function customer(over: Partial<Customer> = {}): Customer {
  const nowIso = new Date().toISOString();
  return { senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default', createdAt: nowIso, updatedAt: nowIso, ...over } as Customer;
}

const chat = vi.fn(async (..._a: unknown[]) => ({ role: 'assistant' as const, content: 'Hello from the dashboard!' }));

function webChat(over: Record<string, unknown> = {}) {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  return {
    store,
    chatBot: createWebChat({
      chat: chat as never,
      store,
      scheduleStore: createScheduleStore(db),
      draftStore: createDraftStore(redis),
      customerStore,
      dailyVolumeStore: createDailyVolumeStore(store),
      monthlyVolumeStore: createMonthlyVolumeStore(store),
      kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
      partnerStore: createPartnerStore(db),
      conversationLog: createConversationLogRepo(db),
      ...over,
    }),
  };
}

const noticeRows = async () =>
  ((await db.execute(sql`SELECT partner_id, meta FROM audit_events WHERE action = ${AI_NOTICE_ACTION} ORDER BY id`)) as unknown as {
    rows: Array<{ partner_id: string; meta: Record<string, unknown> }>;
  }).rows;
const outLog = async (tenant = 'default') =>
  (await createConversationLogRepo(db).listThread(tenant, PHONE)).filter((m) => m.direction === 'out').map((m) => m.text);

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  events.list = [];
  chat.mockReset();
  chat.mockResolvedValue({ role: 'assistant', content: 'Hello from the dashboard!' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('R17 on the web chat', () => {
  it('the first reply carries the web notice and writes one web marker; the next reply does not', async () => {
    const { chatBot } = webChat();
    expect(await chatBot.runTurn(customer(), 'hi')).toBe(`${NOTICE_WEB}\n\nHello from the dashboard!`);
    expect(await chatBot.runTurn(customer(), 'what is the rate')).toBe('Hello from the dashboard!');
    const n = await noticeRows();
    expect(n).toHaveLength(1);
    expect(n[0].meta).toMatchObject({ surface: 'web', channel: 'web', lang: 'en' });
    expect(await outLog()).toEqual([`${NOTICE_WEB}\n\nHello from the dashboard!`, 'Hello from the dashboard!']);
  });

  it('the web marker is separate from WhatsApp and per tenant', async () => {
    await seedPartner(db, 'acme');
    const { chatBot } = webChat();
    await chatBot.runTurn(customer(), 'hi');
    expect(await chatBot.runTurn(customer({ partnerId: 'acme' }), 'hi')).toBe(`${NOTICE_WEB}\n\nHello from the dashboard!`);
  });

  it('a fallback reply carries the notice too', async () => {
    chat.mockRejectedValue(new Error('model down'));
    const { chatBot } = webChat({ alertLlmDown: async () => {} });
    expect(await chatBot.runTurn(customer(), 'hi')).toBe(`${NOTICE_WEB}\n\n${FALLBACK_REPLY}`);
  });
});

describe('R43 on the web chat', () => {
  it('HELP opens one case, answers with the web where-line, never calls the model, and pokes after the commit', async () => {
    const { chatBot } = webChat();
    const reply = await chatBot.runTurn(customer(), 'HELP');
    expect(chat).not.toHaveBeenCalled();
    const cases = await createTicketRepo(db).listByCustomerInTenant('default', PHONE);
    expect(cases).toHaveLength(1);
    expect(reply).toBe(`${NOTICE_WEB}\n\n${helpIntentReply({ intent: 'help', lang: 'en' }, { caseId: cases[0].id, channel: 'web' })}`);
    expect(events.list).toEqual(['poke']);
    expect(await outLog()).toEqual([reply]);
  });

  it('a cancel request with a paid transfer records a cancel case and still runs the model', async () => {
    const { chatBot, store } = webChat();
    const now = new Date().toISOString();
    await store.saveTransfer({
      id: 'tx_webcancel', phone: PHONE, amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 83, amountInr: 8300,
      recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'paid', createdAt: now, paidAt: now,
      sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
      amountSource: 100, feeSource: 1, totalChargeSource: 101, transferType: 'b2c',
    } as Transfer);
    await chatBot.runTurn(customer(), 'cancel my transfer');
    expect(chat).toHaveBeenCalled();
    expect(await createTicketRepo(db).listByCustomerInTenant('default', PHONE)).toHaveLength(1);
  });
});

describe('R56 and the R26 slot on the web chat', () => {
  it('a clear off-topic request gets the fixed decline without the model', async () => {
    const { chatBot } = webChat();
    expect(await chatBot.runTurn(customer(), 'write me a python script')).toBe(`${NOTICE_WEB}\n\n${OFF_TOPIC_REPLY}`);
    expect(chat).not.toHaveBeenCalled();
  });

  it('a paused tenant gets the fixed menu without the model', async () => {
    const { chatBot } = webChat({ agentPaused: async () => true });
    expect(await chatBot.runTurn(customer(), 'send $100 to Mom')).toBe(`${NOTICE_WEB}\n\n${pausedReply('en')}`);
    expect(chat).not.toHaveBeenCalled();
  });
});
