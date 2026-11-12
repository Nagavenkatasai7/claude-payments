import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
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
import { ENGLISH_STEPS_SECTION, buildSystemPrompt } from '@/lib/prompt';
import type { ChatMessage, PartnerId } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifiedLiveControls, certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';

// Fix pack 6 T12 (P12, Q-R46.2): the routed partner row the agent already reads
// decides the ENGLISH TRANSACTION STEPS section (isLiveCertified). No rail read
// decides it; an uncertified, revoked or suspended partner and the default
// tenant get a prompt byte-identical to today's.

const railReads = vi.hoisted(() => ({ repo: 0, providerType: 0, realMoney: 0, counting: false }));

vi.mock('@/lib/partner-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/partner-rates')>()),
  selectSettlementRoute: vi.fn(
    async (_db: unknown, _i: unknown, _s: unknown, _d: unknown, mid: number) => ({ fxRate: mid, source: 'platform' as const }),
  ),
}));
vi.mock('@/db/repos/integrations-repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      if (railReads.counting) railReads.repo += 1;
      return real.createIntegrationsRepo(...a);
    },
  };
});
vi.mock('@/lib/live-gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/live-gate')>();
  return {
    ...real,
    readRailProviderType: async (...a: Parameters<typeof real.readRailProviderType>) => {
      if (railReads.counting) railReads.providerType += 1;
      return real.readRailProviderType(...a);
    },
    realMoneyFor: async (...a: Parameters<typeof real.realMoneyFor>) => {
      if (railReads.counting) railReads.realMoney += 1;
      return real.realMoneyFor(...a);
    },
  };
});

const PHONE = '15551234567';
let db: Db;

async function turn(partnerId: PartnerId): Promise<string> {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US',
    partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Rivera',
  });
  const seen: ChatMessage[][] = [];
  const agent = createAgent({
    partnerId,
    store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(fakeRedis()), customerStore,
    dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db),
    chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'Hola!' }; },
  });
  railReads.counting = true;
  try {
    await agent.runAgentTurn(PHONE, 'hola', { isNewConversation: false });
  } finally {
    railReads.counting = false;
  }
  expect(seen.length).toBeGreaterThan(0);
  return seen[0][0].content as string;
}

/** The prompt an uncertified tenant with the same settings sees (no section). */
const UNCERTIFIED = () => buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: false, kycMode: 'ours' });

async function writeLiveControls(id: string, lc: unknown) {
  await db.execute(sql`UPDATE partners SET live_controls = ${JSON.stringify(lc)}::jsonb WHERE id = ${id}`);
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  railReads.repo = 0;
  railReads.providerType = 0;
  railReads.realMoney = 0;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }) }));
});

describe('agent English transaction steps (pack 6 P12)', () => {
  it('a certified partner (no rail row at all) -> the system prompt contains ENGLISH_STEPS_SECTION once, and no rail is read', async () => {
    await seedPartner(db, 'acme', 'Acme');
    await certifyPartnerForTest(db, 'acme');
    const prompt = await turn('acme');
    expect(prompt.split(ENGLISH_STEPS_SECTION).length).toBe(2);
    expect(prompt).toBe(buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: false, kycMode: 'ours', englishTransactionSteps: true }));
    expect(railReads).toMatchObject({ repo: 0, providerType: 0, realMoney: 0 });
  });

  it('the same partner uncertified -> no section, and the prompt equals the build without the flag', async () => {
    await seedPartner(db, 'acme', 'Acme');
    const prompt = await turn('acme');
    expect(prompt).not.toContain('ENGLISH TRANSACTION STEPS');
    expect(prompt).toBe(UNCERTIFIED());
  });

  it('revoked (revokedAt after certifiedAt) -> no section', async () => {
    await seedPartner(db, 'acme', 'Acme');
    const lc = certifiedLiveControls();
    const revokedAt = new Date(Date.parse(lc.certification!.certifiedAt) + 30_000).toISOString();
    await writeLiveControls('acme', { ...lc, certification: { ...lc.certification, revokedAt } });
    const prompt = await turn('acme');
    expect(prompt).not.toContain('ENGLISH TRANSACTION STEPS');
    expect(prompt).toBe(UNCERTIFIED());
  });

  it('suspended (status not active) with a certification on file -> no section', async () => {
    await seedPartner(db, 'acme', 'Acme');
    await certifyPartnerForTest(db, 'acme');
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'acme'`);
    const prompt = await turn('acme');
    expect(prompt).not.toContain('ENGLISH TRANSACTION STEPS');
  });

  it('the default tenant -> no section, prompt byte-identical to the default build', async () => {
    const prompt = await turn('default');
    expect(prompt).not.toContain('ENGLISH TRANSACTION STEPS');
    expect(prompt).toBe(UNCERTIFIED());
  });

  it('a real-money (http) rail on an uncertified partner does not turn it on', async () => {
    await seedPartner(db, 'acme', 'Acme');
    await seedRealMoneyRail(db, 'acme');
    const prompt = await turn('acme');
    expect(prompt).not.toContain('ENGLISH TRANSACTION STEPS');
    expect(prompt).toBe(UNCERTIFIED());
  });
});
