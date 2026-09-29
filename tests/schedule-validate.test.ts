import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ToolContext } from '@/lib/tools';
import { validateScheduleInput, type ScheduleInput } from '@/lib/schedule-validate';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { MAX_USD, MIN_USD } from '@/lib/fx';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// UI redesign M2-10: validateScheduleInput, the shared create-schedule validation (bot + portal).

const PHONE = '15551239999';
const MOM = '919876543210';
const BANK = '123456789012|HDFC0001234';
let db: Db;

async function ctxFor(opts: { noName?: boolean } = {}): Promise<ToolContext> {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    ...(opts.noName ? {} : { fullName: 'Alex Rivera' }), createdAt: nowIso, updatedAt: nowIso,
  } as Customer);
  return {
    phone: PHONE, partnerId: 'default', store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis),
    turn: { isNewConversation: false }, customerStore, dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store), kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  recipientPhone: MOM, recipientName: 'Mom', amountSource: 100, fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 5,
  destinationCountry: 'IN', ...over,
});
const saveMom = (ctx: ToolContext) =>
  ctx.store.upsertRecipient('default', PHONE, { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: BANK, lastUsedAt: new Date().toISOString() });

beforeEach(async () => {
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test: a schedule prices at run time'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validateScheduleInput', () => {
  it('builds the schedule from the context and the SERVER-side payout (never an input field)', async () => {
    const ctx = await ctxFor();
    await saveMom(ctx);
    const r = await validateScheduleInput(ctx, { ...input(), payoutDestination: 'evil' } as ScheduleInput);
    expect(r).toEqual({
      ok: true,
      schedule: {
        phone: PHONE, partnerId: 'default', amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', recipientName: 'Mom',
        recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: BANK, fundingMethod: 'bank_transfer', frequency: 'monthly',
        dayOfMonth: 5, dayOfWeek: undefined, status: 'active', endDate: undefined,
      },
    });
  });

  it('monthly day 1–28 and weekly day 0–6; anything else is day_range with its frequency', async () => {
    const ctx = await ctxFor();
    for (const d of [1, 28]) expect((await validateScheduleInput(ctx, input({ dayOfMonth: d }))).ok).toBe(true);
    for (const d of [0, 29, 1.5, undefined, 'x']) {
      expect(await validateScheduleInput(ctx, input({ dayOfMonth: d }))).toEqual({ ok: false, code: 'day_range', frequency: 'monthly' });
    }
    for (const d of [0, 6]) expect((await validateScheduleInput(ctx, input({ frequency: 'weekly', dayOfWeek: d }))).ok).toBe(true);
    for (const d of [-1, 7, undefined]) {
      expect(await validateScheduleInput(ctx, input({ frequency: 'weekly', dayOfWeek: d }))).toEqual({ ok: false, code: 'day_range', frequency: 'weekly' });
    }
  });

  it('India only: another destination or a non-Indian number is corridor; an unknown one is unknown_destination', async () => {
    const ctx = await ctxFor();
    expect(await validateScheduleInput(ctx, input({ destinationCountry: 'MX' }))).toEqual({ ok: false, code: 'corridor' });
    expect(await validateScheduleInput(ctx, input({ destinationCountry: undefined, recipientPhone: '5215512345678' }))).toEqual({ ok: false, code: 'corridor' });
    expect(await validateScheduleInput(ctx, input({ destinationCountry: 'ZZ' }))).toEqual({ ok: false, code: 'unknown_destination' });
  });

  it('refuses a bad phone and a non-consumer funding method', async () => {
    const ctx = await ctxFor();
    expect(await validateScheduleInput(ctx, input({ recipientPhone: '12' }))).toEqual({ ok: false, code: 'invalid_phone' });
    expect(await validateScheduleInput(ctx, input({ fundingMethod: 'bank_pull' }))).toEqual({ ok: false, code: 'bad_funding' });
  });

  it('requires the sender legal name on file', async () => {
    const ctx = await ctxFor({ noName: true });
    expect(await validateScheduleInput(ctx, input())).toEqual({ ok: false, code: 'sender_name' });
  });

  it('amountBounds (portal only): finite, at most 2 decimals, inside the USD platform range', async () => {
    const ctx = await ctxFor();
    for (const a of [MIN_USD, 100.5, MAX_USD]) {
      expect((await validateScheduleInput(ctx, input({ amountSource: a }), { amountBounds: true })).ok).toBe(true);
    }
    for (const a of [0, -5, MIN_USD - 0.01, MAX_USD + 0.01, 100.001, Number.NaN, Number.POSITIVE_INFINITY, '100', null]) {
      expect(await validateScheduleInput(ctx, input({ amountSource: a }), { amountBounds: true })).toEqual({ ok: false, code: 'amount' });
    }
    // Without the option (the bot) the amount is not checked here: bot behaviour is unchanged.
    expect((await validateScheduleInput(ctx, input({ amountSource: 0 }))).ok).toBe(true);
  });

  it('requirePayout (portal only): no stored payout, or a deleted recipient, is no_payout', async () => {
    const ctx = await ctxFor();
    expect(await validateScheduleInput(ctx, input(), { requirePayout: true })).toEqual({ ok: false, code: 'no_payout' });
    await saveMom(ctx);
    expect((await validateScheduleInput(ctx, input(), { requirePayout: true })).ok).toBe(true);
    await ctx.store.tombstoneRecipient('default', PHONE, MOM);
    expect(await validateScheduleInput(ctx, input(), { requirePayout: true })).toEqual({ ok: false, code: 'no_payout' });
    // The bot's cold start is unchanged: '' (collected on the pay page each run).
    const bot = await validateScheduleInput(ctx, input());
    expect(bot.ok && bot.schedule.payoutDestination).toBe('');
  });

  it('writes nothing: no schedule row is saved by validation', async () => {
    const ctx = await ctxFor();
    await saveMom(ctx);
    await validateScheduleInput(ctx, input());
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM schedules`)) as unknown as { rows: Array<{ n: number }> };
    expect(n.rows[0].n).toBe(0);
  });
});
