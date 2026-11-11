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
import type { ChatMessage, PartnerId } from '@/lib/types';
import type { ToolContext } from '@/lib/tools';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest } from './helpers-live';

// Fix pack 4 (C22 d): the routed tenant's approved provider line reaches the
// system prompt (one PROVIDER section) and the turn's ToolContext. The default
// tenant and an unapproved partner get neither (prompt byte-identical, no key).

const ctxSeen = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@/lib/partner-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/partner-rates')>()),
  selectSettlementRoute: vi.fn(
    async (_db: unknown, _i: unknown, _s: unknown, _d: unknown, mid: number) => ({ fxRate: mid, source: 'platform' as const }),
  ),
}));
vi.mock('@/lib/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/tools')>();
  return {
    ...real,
    buildCustomerContext: (ctx: ToolContext) => {
      ctxSeen.list.push(ctx);
      return real.buildCustomerContext(ctx);
    },
  };
});

const PHONE = '15551234567';
const LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';
let db: Db;

async function turn(partnerId: PartnerId) {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US',
    partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Rivera',
  });
  const seen: ChatMessage[][] = [];
  ctxSeen.list = [];
  const agent = createAgent({
    partnerId,
    store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(fakeRedis()), customerStore,
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db),
    chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'Hi!' }; },
  });
  await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: false });
  expect(seen.length).toBeGreaterThan(0);
  const prompt = seen[0][0].content as string;
  expect(ctxSeen.list.length).toBe(1);
  return { prompt, ctx: ctxSeen.list[0] as ToolContext };
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }));
});

describe('agent provider line (pack 4 C22 d)', () => {
  it('an approved routed partner -> the system prompt has the PROVIDER section and ctx.providerLine is the line', async () => {
    await seedPartner(db, 'acme', 'Acme');
    await approveDisclosureForTest(db, 'acme');
    const { prompt, ctx } = await turn('acme');
    expect(prompt).toContain(`\n\nPROVIDER\n- When a customer asks who provides or holds the money, say: "${LINE}"`);
    expect(ctx.providerLine).toBe(LINE);
  });

  it('the default tenant -> no section, ctx has no providerLine key', async () => {
    const { prompt, ctx } = await turn('default');
    expect(prompt).not.toContain('\nPROVIDER\n');
    expect('providerLine' in ctx).toBe(false);
  });

  it('an unapproved partner -> no section, ctx has no providerLine key', async () => {
    await seedPartner(db, 'acme', 'Acme');
    const { prompt, ctx } = await turn('acme');
    expect(prompt).not.toContain('\nPROVIDER\n');
    expect('providerLine' in ctx).toBe(false);
  });
});
