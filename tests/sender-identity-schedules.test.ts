import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool } from '@/lib/tools';
import { runDueSchedules } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import type { KycProvider } from '@/lib/providers/kyc-provider';
import type { Schedule } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// Scheduled sends require and screen the sender's legal name (Program-Fix 14
// follow-up): a schedule is set up only once a legal name is on file, every
// scheduled mint screens it with the recipient's, and a due schedule whose
// owner has no name on file mints nothing that day (one deduped ops alert,
// the schedule stays active and resumes once a name exists).

const PHONE = '15550007777';
const NAME_QUESTION = "What's your full legal name, as on your ID?";
const NOW = Date.parse('2026-05-21T16:00:00.000Z'); // day-of-month 21 (Eastern 2026-05-21)
const SCHEDULE_ARGS = {
  amount_source: 100,
  funding_method: 'bank_transfer',
  recipient_name: 'Mom',
  recipient_phone: '919876543210',
  destination_country: 'IN',
  frequency: 'monthly',
  day_of_month: 21,
} as const;

const kycProvider: KycProvider = {
  startVerification: async () => ({ url: 'https://kyc.example/verify', providerRef: 'ref_1' }),
  getStatus: async () => 'pending',
  handleWebhook: async () => null,
};

let db: Db;

async function seedOwner(customerStore: ReturnType<typeof createCustomerStore>, fullName?: string) {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
    ...(fullName ? { fullName } : {}),
  });
}

async function buildCtx(opts: { fullName?: string } = {}) {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  await seedOwner(customerStore, opts.fullName);
  return {
    phone: PHONE,
    partnerId: 'default',
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}
type Ctx = Awaited<ReturnType<typeof buildCtx>>;

function sched(id: string): Schedule {
  return {
    id, phone: PHONE, amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 21, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'default', sourceCurrency: 'USD', amountSource: 200,
  };
}

function cronDeps(ctx: Ctx, notified: string[] = []) {
  return {
    db, store: ctx.store, partnerStore: ctx.partnerStore, customerStore: ctx.customerStore,
    monthlyVolumeStore: ctx.monthlyVolumeStore, scheduleStore: ctx.scheduleStore, kycProvider, now: NOW,
    sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => { notified.push(url); },
  };
}

async function opsAlerts() {
  const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> }).rows;
}

async function sanctionsRows() {
  const r = (await db.execute(
    sql`SELECT subject_id, meta FROM audit_events WHERE action = 'sanctions.screen'`,
  )) as unknown as { rows: Array<{ subject_id: string; meta: Record<string, unknown> }> };
  return r.rows;
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ rates: { INR: 85 } }),
    text: async () => '',
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduled sends require the sender name — create_schedule', { retry: 0 }, () => {
  it('a sender with no name on file gets the name question and no schedule is saved', async () => {
    const ctx = await buildCtx();
    const save = vi.spyOn(ctx.scheduleStore, 'saveSchedule');
    const r = await executeTool('create_schedule', { ...SCHEDULE_ARGS }, ctx);
    expect(r.needs_sender_name).toBe(true);
    expect(r.reply_to_customer).toBe(NAME_QUESTION);
    expect(r.schedule_id).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(0);
  });

  it('a whitespace-only name on file counts as no name', async () => {
    const ctx = await buildCtx({ fullName: '   ' });
    const r = await executeTool('create_schedule', { ...SCHEDULE_ARGS }, ctx);
    expect(r.needs_sender_name).toBe(true);
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(0);
  });

  it('after set_sender_name the same create_schedule call saves the schedule', async () => {
    const ctx = await buildCtx();
    expect((await executeTool('create_schedule', { ...SCHEDULE_ARGS }, ctx)).needs_sender_name).toBe(true);
    expect((await executeTool('set_sender_name', { full_name: 'Alex Rivera' }, ctx)).saved).toBe(true);
    const r = await executeTool('create_schedule', { ...SCHEDULE_ARGS }, ctx);
    expect(typeof r.schedule_id).toBe('string');
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(1);
  });

  it('argument refusals still come first (a non-India schedule is refused the same way)', async () => {
    const ctx = await buildCtx();
    const r = await executeTool('create_schedule', { ...SCHEDULE_ARGS, destination_country: 'MX' }, ctx);
    expect(r.needs_sender_name).toBeUndefined();
    expect(typeof r.error).toBe('string');
  });
});

describe('scheduled sends screen the sender name — cron run', { retry: 0 }, () => {
  it('a named owner: the scheduled mint screens the sender party too', async () => {
    const ctx = await buildCtx({ fullName: 'Alex Rivera' });
    await ctx.scheduleStore.saveSchedule(sched('due'));
    const notified: string[] = [];
    const result = await runDueSchedules(cronDeps(ctx, notified));
    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(notified).toHaveLength(1);
    const rows = await sanctionsRows();
    expect(rows).toHaveLength(1);
    const parties = rows[0].meta.parties as Array<Record<string, unknown>>;
    expect(parties.find((p) => p.role === 'sender')).toMatchObject({ matched: false });
  });

  it('a watchlisted owner name: the scheduled mint is blocked with sender evidence and no pay link', async () => {
    const ctx = await buildCtx({ fullName: 'Test Blocked' });
    await ctx.scheduleStore.saveSchedule(sched('due'));
    const notified: string[] = [];
    const result = await runDueSchedules(cronDeps(ctx, notified));
    expect(result.fired).toBe(1); // same accounting as a blocked recipient
    expect(notified).toHaveLength(0);
    const blocked = (await ctx.store.listTransfers()).filter((t) => t.status === 'blocked');
    expect(blocked).toHaveLength(1);
    const rows = await sanctionsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(blocked[0].id);
    const parties = rows[0].meta.parties as Array<Record<string, unknown>>;
    expect(parties.find((p) => p.role === 'sender')).toMatchObject({ matched: true });
    expect(JSON.stringify(rows[0].meta).toLowerCase()).not.toContain('test blocked');
  });

  it('a nameless owner: no mint, no claim, not marked run, stays active, ONE PII-free deduped alert', async () => {
    const ctx = await buildCtx();
    await ctx.scheduleStore.saveSchedule(sched('due'));
    const notified: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runDueSchedules(cronDeps(ctx, notified));
    expect(first).toEqual({ fired: 0, failed: 1 });
    const second = await runDueSchedules(cronDeps(ctx, notified)); // same-day re-run
    expect(second).toEqual({ fired: 0, failed: 1 });

    expect(notified).toHaveLength(0);
    expect(await ctx.store.listTransfers()).toHaveLength(0);
    expect(await createIdempotencyRepo(db).find('default', 'sched:due:2026-05-21')).toBeNull();
    const saved = await ctx.scheduleStore.getSchedule('due');
    expect(saved?.status).toBe('active');
    expect(saved?.lastRunAt).toBeUndefined();
    const alerts = await opsAlerts();
    expect(alerts.map((a) => a.dedupe_key)).toEqual(['schedule-sender-name:due:2026-05-21']);
    expect(alerts[0].payload.message).toContain('due');
    expect(alerts[0].payload.message).toContain('sender_name_missing');
    expect(alerts[0].payload.message).toContain('No sender legal name is on file; the schedule stays active');
    expect(alerts[0].payload.message).not.toMatch(/\d{7,}/); // never the customer's phone
    expect(await sanctionsRows()).toHaveLength(0);
  });

  it('once the owner gives a name, a same-day re-run mints and screens it', async () => {
    const ctx = await buildCtx();
    await ctx.scheduleStore.saveSchedule(sched('due'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDueSchedules(cronDeps(ctx))).toEqual({ fired: 0, failed: 1 });

    expect((await executeTool('set_sender_name', { full_name: 'Alex Rivera' }, ctx)).saved).toBe(true);
    const notified: string[] = [];
    expect(await runDueSchedules(cronDeps(ctx, notified))).toEqual({ fired: 1, failed: 0 });
    expect(notified).toHaveLength(1);
    expect((await ctx.scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
    const parties = (await sanctionsRows()).flatMap((r) => r.meta.parties as Array<Record<string, unknown>>);
    expect(parties.some((p) => p.role === 'sender')).toBe(true);
  });

  it('a delegated-KYC partner with no customer row at all: still no mint (the name is required either way)', async () => {
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'default'`);
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    const scheduleStore = createScheduleStore(db);
    await scheduleStore.saveSchedule(sched('due'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore: createPartnerStore(db), customerStore,
      monthlyVolumeStore: createMonthlyVolumeStore(store), scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    expect((await scheduleStore.getSchedule('due'))?.status).toBe('active');
    expect((await opsAlerts()).map((a) => a.dedupe_key)).toEqual(['schedule-sender-name:due:2026-05-21']);
  });
});
