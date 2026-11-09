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
import { resetRateCacheForTests } from '@/lib/rate';
import type { ChatMessage } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// R30 (no tipping-off): whatever a tool returns, the agent writes only its
// model-visible copy into the history (src/lib/model-visible-result.ts). The
// tool is stubbed to return the old leaky fields so the gate itself is tested.
vi.mock('@/lib/tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/tools')>();
  return {
    ...orig,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: Parameters<typeof orig.executeTool>[2]) =>
      name === 'check_send_limit'
        ? {
            within_cap: false,
            reason: 'over_daily_cap',
            today_used_usd: 300,
            today_remaining_usd: 134,
            edd_threshold_usd: 3000,
            reply_to_customer: 'This is more than you can send today.',
            cap_eval: { compliance_status: 'flagged', compliance_reasons: ['watchlist'], tier: 'T0' },
          }
        : orig.executeTool(name, args, ctx),
    ),
  };
});

let db: Db;
const PHONE = '15551234567';

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent: a tool result enters the history only as its model-visible copy (R30)', () => {
  it('strips the remaining figure, the EDD threshold and screening fields, at any depth', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    const nowIso = new Date().toISOString();
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
      optInAt: nowIso, fullName: 'Alex Rivera', createdAt: nowIso, updatedAt: nowIso,
    });
    const seen: ChatMessage[][] = [];
    const responses: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_send_limit', arguments: '{"amount_usd":200}' } }] },
      { role: 'assistant', content: 'This is more than you can send today.' },
    ];
    let i = 0;
    const agent = createAgent({
      store,
      scheduleStore: createScheduleStore(db),
      draftStore: createDraftStore(redis),
      customerStore,
      dailyVolumeStore: createDailyVolumeStore(store),
      monthlyVolumeStore: createMonthlyVolumeStore(store),
      kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
      partnerStore: createPartnerStore(db),
      chat: async (messages: ChatMessage[]) => {
        seen.push(messages.map((m) => ({ ...m })));
        return responses[i++];
      },
    });
    await agent.runAgentTurn(PHONE, 'send 200 to mom');

    const toolMsg = seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(toolMsg).toBeDefined();
    const result = JSON.parse(String(toolMsg!.content)) as Record<string, unknown>;
    expect(result).toEqual({
      within_cap: false,
      reason: 'over_daily_cap',
      reply_to_customer: 'This is more than you can send today.',
      cap_eval: { tier: 'T0' },
    });
    const persisted = JSON.stringify(await store.getConversation('default', PHONE));
    for (const k of ['today_remaining_usd', 'today_used_usd', 'edd_threshold_usd', 'compliance_status', 'compliance_reasons']) {
      expect(persisted).not.toContain(k);
    }
  });
});
