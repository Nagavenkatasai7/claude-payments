import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool, scheduleRefusalToolResult, type ToolContext } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { FIXED_REPLIES, fixedReply } from '@/lib/hold-replies';
import type { Db } from '@/db/client';
import type { Customer, PartnerId } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';

// Fix pack 3 T12 (R13, contract 15): the bot's B2B tools on a tenant that is
// CERTIFIED for live money run only when its b2b capability is open (counsel
// ref + partner approval). Closed, or the partner read fails (fail CLOSED):
// { error: fixedReply('cannot_complete') } and nothing runs. Uncertified
// tenants and the default tenant are unchanged; the default tenant makes no
// partner read. create_schedule refuses `capability_off` with the neutral
// `schedule_unavailable` text.

const PHONE = '15551230077';
const B2B_TOOLS = ['present_bill', 'register_seller', 'create_invoice', 'cancel_bill', 'dispute_bill'] as const;

let db: Db;

beforeEach(async () => {
  db = await freshDb();
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildCtx(partnerId: PartnerId): Promise<ToolContext> {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US', partnerId,
    optInAt: nowIso, fullName: 'Alex Rivera', createdAt: nowIso, updatedAt: nowIso,
  } as Customer);
  return {
    phone: PHONE,
    partnerId,
    channel: 'whatsapp',
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false },
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  } as ToolContext;
}

async function counts() {
  const n = async (table: string) =>
    Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n);
  return { sellers: await n('sellers'), invoices: await n('b2b_invoices'), transfers: await n('transfers'), outbox: await n('outbox'), audit: await n('audit_events') };
}

function logLines(warn: ReturnType<typeof vi.spyOn>, scope: string): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((c: unknown[]) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
    .filter((l: Record<string, unknown> | null): l is Record<string, unknown> => l?.scope === scope);
}

const SELLER = { business_name: 'Acme Imports Ltd' };

describe('bot B2B tools and the b2b capability (fix pack 3 T12)', { retry: 0 }, () => {
  it.each(B2B_TOOLS)('%s on a certified tenant with b2b closed -> { error: fixedReply(cannot_complete) }, nothing written', async (tool) => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { optIns: ['usdc', 'schedules', 'mcp', 'telegram'] });
    const ctx = await buildCtx('acme');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await counts();
    const r = await executeTool(tool, tool === 'register_seller' ? SELLER : {}, ctx);
    expect(r).toEqual({ error: fixedReply('cannot_complete') });
    expect(await counts()).toEqual(before);
    const lines = logLines(warn, 'capability.tool-blocked');
    expect(lines).toHaveLength(1);
    expect(lines[0].tool).toBe(tool);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PHONE);
  });

  it('b2b open -> the tool runs (its own result, not cannot_complete)', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { optIns: ['b2b'] });
    const ctx = await buildCtx('acme');
    for (const tool of B2B_TOOLS) {
      const r = await executeTool(tool, {}, ctx);
      expect(r).not.toEqual({ error: fixedReply('cannot_complete') });
    }
  });

  it('register_seller on an open certified tenant writes its seller', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { optIns: ['b2b'] });
    const ctx = await buildCtx('acme');
    await executeTool('register_seller', SELLER, ctx);
    expect((await counts()).sellers).toBe(1);
  });

  it('check_bill_status is never gated', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { optIns: [] });
    const ctx = await buildCtx('acme');
    const getPartner = vi.spyOn(ctx.partnerStore, 'getPartner');
    const r = await executeTool('check_bill_status', {}, ctx);
    expect(r).not.toEqual({ error: fixedReply('cannot_complete') });
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('uncertified tenant -> runs as today', async () => {
    await seedPartner(db, 'acme');
    const ctx = await buildCtx('acme');
    await executeTool('register_seller', SELLER, ctx);
    expect((await counts()).sellers).toBe(1);
    for (const tool of B2B_TOOLS) {
      expect(await executeTool(tool, {}, ctx)).not.toEqual({ error: fixedReply('cannot_complete') });
    }
  });

  it('default tenant -> no partner read', async () => {
    const ctx = await buildCtx('default');
    const getPartner = vi.spyOn(ctx.partnerStore, 'getPartner');
    for (const tool of B2B_TOOLS) {
      expect(await executeTool(tool, {}, ctx)).not.toEqual({ error: fixedReply('cannot_complete') });
    }
    expect(getPartner).not.toHaveBeenCalled();
  });

  it('partner read throws -> cannot_complete (fail closed), error name logged', async () => {
    await seedPartner(db, 'acme');
    const ctx = await buildCtx('acme');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class PartnerReadError extends Error { constructor() { super('db down'); this.name = 'PartnerReadError'; } }
    vi.spyOn(ctx.partnerStore, 'getPartner').mockRejectedValue(new PartnerReadError());
    const before = await counts();
    expect(await executeTool('register_seller', SELLER, ctx)).toEqual({ error: fixedReply('cannot_complete') });
    expect(await counts()).toEqual(before);
    const lines = logLines(warn, 'capability.tool-blocked');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'register_seller', error: 'PartnerReadError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('db down');
  });
});

describe('create_schedule and the schedules capability (fix pack 3 T12)', { retry: 0 }, () => {
  it('capability_off, licence and corridor_closed all map to the schedule_unavailable text', () => {
    for (const code of ['capability_off', 'licence', 'corridor_closed'] as const) {
      expect(scheduleRefusalToolResult({ ok: false, code })).toEqual({ error: FIXED_REPLIES.schedule_unavailable });
    }
  });

  const args = {
    amount_source: 100, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: '919876543210',
    destination_country: 'IN', frequency: 'monthly', day_of_month: 5,
  };

  it('create_schedule capability_off -> { error: FIXED_REPLIES.schedule_unavailable }, nothing written', async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { optIns: ['b2b', 'usdc'] });
    const ctx = await buildCtx('acme');
    const before = await counts();
    const r = await executeTool('create_schedule', args, ctx);
    expect(r).toEqual({ error: FIXED_REPLIES.schedule_unavailable });
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM schedules`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
    expect(await counts()).toEqual(before);
  });
});
