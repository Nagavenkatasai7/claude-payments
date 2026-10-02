import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { SCHEDULE_NEEDS_NAME_NOTE } from '@/lib/prompt';
import type { ChatMessage, Schedule } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// Scheduled-send name nudge, chat side (2026-10-02): a customer with an ACTIVE
// schedule and no legal name on file gets a fixed [SCHEDULE NEEDS NAME] note at
// round 0, so the bot asks for (and saves) the name even though no send tool
// returned needs_sender_name. The note is fixed text: no amount, recipient or id.

vi.mock('@/lib/partner-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/partner-rates')>()),
  selectSettlementRoute: vi.fn(
    async (_db: unknown, _i: unknown, _s: unknown, _d: unknown, mid: number) => ({ fxRate: mid, source: 'platform' as const }),
  ),
}));

const PHONE = '15551234567';
let db: Db;

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_1', phone: PHONE, amountUsd: 200, recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 21, status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'default', sourceCurrency: 'USD', amountSource: 200, ...over,
  };
}

async function systemNotes(opts: { fullName?: string; schedule?: Partial<Schedule> | null }) {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US',
    partnerId: 'default', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
    ...(opts.fullName ? { fullName: opts.fullName } : {}),
  });
  const scheduleStore = createScheduleStore(db);
  if (opts.schedule !== null) await scheduleStore.saveSchedule(sched(opts.schedule ?? {}));
  const seen: ChatMessage[][] = [];
  const agent = createAgent({
    store, scheduleStore, draftStore: createDraftStore(fakeRedis()), customerStore,
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db),
    chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'Hi!' }; },
  });
  await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: false });
  return seen[0].filter((m) => m.role === 'system').map((m) => m.content as string);
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }));
});

describe('[SCHEDULE NEEDS NAME] note', () => {
  it('is injected for a nameless customer with an active schedule, as fixed text', async () => {
    const notes = await systemNotes({});
    expect(notes).toContain(SCHEDULE_NEEDS_NAME_NOTE);
    expect(SCHEDULE_NEEDS_NAME_NOTE.startsWith('[SCHEDULE NEEDS NAME]')).toBe(true);
    expect(SCHEDULE_NEEDS_NAME_NOTE).toContain('set_sender_name');
    expect(SCHEDULE_NEEDS_NAME_NOTE).not.toMatch(/Mom|200|sch_1/);
  });
  it('is not injected once a legal name is on file', async () => {
    expect(await systemNotes({ fullName: 'Alex Rivera' })).not.toContain(SCHEDULE_NEEDS_NAME_NOTE);
  });
  it('is not injected for a paused or cancelled schedule only', async () => {
    expect(await systemNotes({ schedule: { status: 'paused' } })).not.toContain(SCHEDULE_NEEDS_NAME_NOTE);
    db = await freshDb();
    expect(await systemNotes({ schedule: { status: 'cancelled' } })).not.toContain(SCHEDULE_NEEDS_NAME_NOTE);
  });
  it('is not injected with no schedule at all', async () => {
    expect(await systemNotes({ schedule: null })).not.toContain(SCHEDULE_NEEDS_NAME_NOTE);
  });
});
