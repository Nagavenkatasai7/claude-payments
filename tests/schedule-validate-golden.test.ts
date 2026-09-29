import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executeTool, type ToolContext } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend } from './helpers-db';

// UI redesign M2-10: the GOLDEN corpus for the bot's create_schedule.
//
// Captured on UNCHANGED code (before validateScheduleInput was extracted from
// createScheduleTool). Every bot-visible output is recorded: the tool result
// (key order included), the row handed to saveSchedule (less id/createdAt), and
// whether a customers row exists afterwards (resolveSender may create one, so an
// early refusal must keep creating none). The refactor must leave the golden file
// byte-identical. Regenerate ONLY on unchanged code:
//   UPDATE_SCHEDULE_GOLDEN=1 npx vitest run tests/schedule-validate-golden.test.ts

const GOLDEN_PATH = join(__dirname, '__golden__', 'create-schedule.json');
const UPDATE = process.env.UPDATE_SCHEDULE_GOLDEN === '1';

const PHONE = '15551230000';
const MOM = '919876543210';
const SAVED_BANK = '123456789012|HDFC0001234';

let db: Db;

async function buildCtx(opts: { noName?: boolean; noCustomer?: boolean } = {}): Promise<ToolContext> {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  if (!opts.noCustomer) {
    const nowIso = new Date().toISOString();
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
      ...(opts.noName ? {} : { fullName: 'Alex Rivera' }),
      createdAt: nowIso, updatedAt: nowIso,
    } as Customer);
  }
  return {
    phone: PHONE,
    partnerId: 'default',
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false },
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}

const base = (over: Record<string, unknown> = {}) => ({
  amount_source: 100, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
  destination_country: 'IN', frequency: 'monthly', day_of_month: 5, ...over,
});

async function saveMom(ctx: ToolContext) {
  await ctx.store.upsertRecipient('default', PHONE, {
    name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: SAVED_BANK, lastUsedAt: new Date().toISOString(),
  });
}

/** One call, then the observable state it left: the result, the saved rows and the customer row. */
async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  let result: unknown;
  try {
    result = { ok: await executeTool('create_schedule', args, ctx) };
  } catch (err) {
    result = { threw: err instanceof Error ? err.message : String(err) };
  }
  const rows = (await createScheduleRepo(db).listForCustomer('default', PHONE)).map((s) => {
    const { id: _id, createdAt: _c, ...rest } = s;
    return rest;
  });
  const customers = (await db.execute(sql`SELECT count(*)::int AS n FROM customers WHERE phone = ${PHONE}`)) as unknown as { rows: Array<{ n: number }> };
  const r = result as { ok?: Record<string, unknown> };
  if (r.ok && typeof r.ok.schedule_id === 'string') r.ok.schedule_id = '<id>';
  return { result, rows, customerRows: customers.rows[0]?.n ?? 0 };
}

const SCENARIOS: Array<{ name: string; ctx?: { noName?: boolean; noCustomer?: boolean }; setup?: (ctx: ToolContext) => Promise<void>; args: Record<string, unknown> }> = [
  { name: 'monthly.saved_recipient', setup: saveMom, args: base() },
  { name: 'monthly.cold_start_no_payout', args: base() },
  { name: 'weekly.day0', setup: saveMom, args: base({ frequency: 'weekly', day_of_week: 0, day_of_month: undefined }) },
  { name: 'weekly.day6_string', args: base({ frequency: 'weekly', day_of_week: '6' }) },
  { name: 'frequency.garbage_is_monthly', args: base({ frequency: 'daily' }) },
  { name: 'invalid_phone', args: base({ recipient_phone: '12' }) },
  { name: 'bad_funding.crypto', args: base({ funding_method: 'crypto' }) },
  { name: 'bad_funding.bank_pull', args: base({ funding_method: 'bank_pull' }) },
  { name: 'funding.absent', args: base({ funding_method: undefined }) },
  { name: 'funding.debit_card', args: base({ funding_method: 'debit_card' }) },
  { name: 'day_of_month.0', args: base({ day_of_month: 0 }) },
  { name: 'day_of_month.29', args: base({ day_of_month: 29 }) },
  { name: 'day_of_month.1_5', args: base({ day_of_month: 1.5 }) },
  { name: 'day_of_month.absent', args: base({ day_of_month: undefined }) },
  { name: 'weekly.day7', args: base({ frequency: 'weekly', day_of_week: 7 }) },
  { name: 'weekly.day_neg', args: base({ frequency: 'weekly', day_of_week: -1 }) },
  { name: 'destination.unknown', args: base({ destination_country: 'ZZ' }) },
  { name: 'destination.mx', args: base({ destination_country: 'MX' }) },
  { name: 'destination.absent_mx_phone', args: base({ destination_country: undefined, recipient_phone: '5215512345678' }) },
  { name: 'destination.absent_in_phone', args: base({ destination_country: undefined }) },
  { name: 'sender_name.missing', ctx: { noName: true }, args: base() },
  { name: 'sender_name.no_customer_row', ctx: { noCustomer: true }, args: base() },
  { name: 'no_customer_row.invalid_phone_first', ctx: { noCustomer: true }, args: base({ recipient_phone: 'x' }) },
  { name: 'no_customer_row.day_first', ctx: { noCustomer: true }, args: base({ day_of_month: 40 }) },
  { name: 'amount.legacy_amount_usd', args: base({ amount_source: undefined, amount_usd: 55 }) },
  { name: 'amount.zero', args: base({ amount_source: 0 }) },
  { name: 'amount.huge', args: base({ amount_source: 99999 }) },
  { name: 'amount.string', args: base({ amount_source: '75.5' }) },
  { name: 'end_date.valid', args: base({ end_date: '2027-01-31' }) },
  { name: 'end_date.garbage', args: base({ end_date: 'not a date' }) },
  { name: 'end_date.blank', args: base({ end_date: '   ' }) },
  { name: 'source_currency.gbp_request', args: base({ source_currency: 'GBP' }) },
  { name: 'recipient_name.number', args: base({ recipient_name: 42 }) },
  {
    name: 'payout.ledger_fallback',
    setup: async () => {
      const id = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
      await db.execute(sql`UPDATE transfers SET recipient_phone = ${MOM} WHERE id = ${id}`);
    },
    args: base(),
  },
  {
    name: 'payout.tombstoned_recipient',
    setup: async (ctx) => {
      await saveMom(ctx);
      await ctx.store.tombstoneRecipient('default', PHONE, MOM);
    },
    args: base(),
  },
];

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('create_schedule golden (bot parity across the validateScheduleInput extraction)', () => {
  it('every scenario matches the golden captured on unchanged code', { timeout: 60_000 }, async () => {
    const out: Record<string, unknown> = {};
    for (const s of SCENARIOS) {
      db = await freshDb();
      const ctx = await buildCtx(s.ctx);
      if (s.setup) await s.setup(ctx);
      out[s.name] = await run(s.args, ctx);
    }
    const text = JSON.stringify(out, null, 2) + '\n';
    if (UPDATE || !existsSync(GOLDEN_PATH)) {
      if (!UPDATE) throw new Error(`golden missing: ${GOLDEN_PATH} (generate on unchanged code with UPDATE_SCHEDULE_GOLDEN=1)`);
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, text);
    }
    expect(text).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });
});
