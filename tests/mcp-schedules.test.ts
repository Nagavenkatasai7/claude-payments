import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { AgentPrincipal } from '@/lib/agent-auth';
import type { ToolContextDeps } from '@/lib/tool-context';
import { createStore, type Store } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { recipientRid } from '@/lib/portal-recipients';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { PURPOSE_DETAIL_MESSAGE, RECIPIENT_NOT_FOUND } from '@/lib/mcp/prepare';
import {
  SCHEDULE_NOT_FOUND,
  SCHEDULE_TOO_MANY_CREATES,
  SCHEDULE_TOO_MANY_CHANGES,
  MCP_SCHEDULE_CHANGE_LIMIT,
  changeScheduleTool,
  createScheduleTool,
  listSchedulesTool,
  nextDueDate,
  scheduleRequestKey,
  type CreateScheduleArgs,
  type ScheduleDeps,
} from '@/lib/mcp/schedules';
import type { Schedule } from '@/lib/types';
import { fakeRedis, type FakeRedis } from './helpers';
import { clearLegalName, freshDb, seedPartner, seedSender } from './helpers-db';

// Repeat payments over MCP (Oct 25): list / create / pause-resume-cancel the customer's OWN
// schedules through the portal's helpers (createPortalSchedule, setPortalScheduleStatus), audited
// as the app (`agent:<client id>`) and marked "Set up in <app>".

const PHONE = '14155550101';
const OTHER_PHONE = '14155550199';
const RECIPIENT_PHONE = '919812345678';

let db: Db;
let redis: FakeRedis;
let store: Store;
let deps: ScheduleDeps;

function toolDeps(): Partial<ToolContextDeps> {
  const customerStore = createCustomerStore(db, store);
  return {
    store,
    customerStore,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: createPartnerStore(db),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
  };
}

const principal = (over: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  grantId: 'agg_test',
  partnerId: 'pa',
  phone: PHONE,
  clientId: 'agc_claude',
  clientName: 'Claude',
  scopes: ['schedules:manage'],
  ...over,
});

const rid = (partnerId = 'pa', phone = PHONE, rp = RECIPIENT_PHONE) => recipientRid(partnerId, phone, rp);
const monthly = (over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs => ({
  recipient_id: rid(),
  amount: 150,
  frequency: 'monthly',
  day_of_month: 5,
  purpose: 'family_support',
  ...over,
});

const count = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM schedules`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
const audits = async () =>
  ((await db.execute(sql`SELECT action, actor, actor_type, meta FROM audit_events WHERE action LIKE 'schedule.%' ORDER BY id`)) as unknown as {
    rows: Array<{ action: string; actor: string; actor_type: string; meta: Record<string, unknown> }>;
  }).rows;
const viaColumn = async (id: string) =>
  ((await db.execute(sql`SELECT created_via FROM schedules WHERE id = ${id}`)) as unknown as { rows: Array<{ created_via: string | null }> }).rows[0]
    ?.created_via;

async function nameOnFile(partnerId: string, phone: string) {
  const customers = createCustomerStore(db, store);
  await customers.saveCustomer({ ...(await customers.getCustomer(partnerId, phone))!, fullName: 'Venu Rao' });
}

async function created(args: CreateScheduleArgs = monthly(), p: AgentPrincipal = principal()): Promise<string> {
  const r = await createScheduleTool(p, args, deps);
  if (!r.ok) throw new Error(`create refused: ${r.message}`);
  return r.data.schedule_id as string;
}

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
  store = createStore(redis, db);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no FX at schedule set-up'); }));
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  await seedSender(db, { partnerId: 'pa', phone: OTHER_PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  await seedSender(db, { partnerId: 'pb', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  await nameOnFile('pa', PHONE);
  await nameOnFile('pa', OTHER_PHONE);
  await nameOnFile('pb', PHONE);
  const saved = { payoutMethod: 'bank' as const, lastUsedAt: new Date().toISOString() };
  await store.upsertRecipient('pa', PHONE, { ...saved, name: 'Asha Kumar', recipientPhone: RECIPIENT_PHONE, payoutDestination: 'HDFC0000001 123456789012' });
  await store.upsertRecipient('pa', OTHER_PHONE, { ...saved, name: 'Other Customer', recipientPhone: '919800000009', payoutDestination: 'SBIN0000001 111122223333' });
  await store.upsertRecipient('pb', PHONE, { ...saved, name: 'Other Tenant', recipientPhone: '919800000001', payoutDestination: 'SBIN0000001 999988887777' });
  deps = { toolDeps: toolDeps(), db, redis };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('create_schedule', () => {
  it('sets up a monthly repeat payment from the saved recipient, marked with the app and audited as the app', async () => {
    const r = await createScheduleTool(principal(), monthly(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      created: true,
      status: 'active',
      recipient_name: 'Asha Kumar',
      recipient_id: rid(),
      amount: 150,
      frequency: 'monthly',
      day_of_month: 5,
      purpose: 'family_support',
      set_up_in: 'Claude',
    });
    expect(r.data.next_due_date).toMatch(/^\d{4}-\d{2}-05$/);
    expect(r.scheduleId).toBe(r.data.schedule_id);
    // Never the account or the recipient's phone.
    expect(JSON.stringify(r.data)).not.toContain('123456789012');
    expect(JSON.stringify(r.data)).not.toContain(RECIPIENT_PHONE);
    const id = r.data.schedule_id as string;
    expect(await viaColumn(id)).toBe('Claude');
    const s = await createScheduleRepo(db).getOwnedSchedule('pa', PHONE, id);
    expect(s).toMatchObject({ payoutDestination: 'HDFC0000001 123456789012', recipientName: 'Asha Kumar', createdVia: 'Claude' });
    expect(await audits()).toEqual([{ action: 'schedule.create', actor: 'agent:agc_claude', actor_type: 'agent', meta: { scheduleId: id } }]);
  });

  it('sets up a weekly repeat payment on the named weekday', async () => {
    const r = await createScheduleTool(principal(), monthly({ frequency: 'weekly', day_of_month: undefined, day_of_week: 'wednesday' }), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ frequency: 'weekly', day_of_week: 'wednesday' });
    expect(r.data).not.toHaveProperty('day_of_month');
    const s = await createScheduleRepo(db).getOwnedSchedule('pa', PHONE, r.data.schedule_id as string);
    expect(s?.dayOfWeek).toBe(3);
  });

  it('refuses a missing day, a past or unreal end date, and "other" without a reason, before anything is written', async () => {
    expect(await createScheduleTool(principal(), monthly({ day_of_month: undefined }), deps)).toEqual({ ok: false, message: 'A monthly repeat payment needs day_of_month (1 to 28).' });
    expect(await createScheduleTool(principal(), monthly({ frequency: 'weekly', day_of_month: undefined }), deps)).toEqual({ ok: false, message: 'A weekly repeat payment needs day_of_week.' });
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect(await createScheduleTool(principal(), monthly({ end_date: yesterday }), deps)).toMatchObject({ ok: false, message: expect.stringContaining('end_date') });
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(await createScheduleTool(principal(), monthly({ end_date: `${nextYear}-02-30` }), deps)).toMatchObject({ ok: false, message: expect.stringContaining('end_date') });
    const other = await createScheduleTool(principal(), monthly({ purpose: 'other' }), deps);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(Object.values(PURPOSE_DETAIL_MESSAGE)).toContain(other.message);
    expect(await count()).toBe(0);
  });

  it('accepts a future end date', async () => {
    const end = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const r = await createScheduleTool(principal(), monthly({ end_date: end }), deps);
    expect(r).toMatchObject({ ok: true, data: { end_date: end } });
  });

  it("isolation: another tenant's or another customer's recipient, or a made-up id, is not found; nothing written", async () => {
    for (const recipient_id of [rid('pb', PHONE, '919800000001'), rid('pa', OTHER_PHONE, '919800000009'), 'r_made_up']) {
      expect(await createScheduleTool(principal(), monthly({ recipient_id }), deps)).toEqual({ ok: false, message: RECIPIENT_NOT_FOUND });
    }
    expect(await count()).toBe(0);
  });

  it('a recipient outside India is refused (India only); nothing written', async () => {
    await store.upsertRecipient('pa', PHONE, { name: 'Uncle', recipientPhone: '5215512345678', payoutMethod: 'bank', payoutDestination: '012345678901234567', lastUsedAt: new Date().toISOString() });
    const r = await createScheduleTool(principal(), monthly({ recipient_id: rid('pa', PHONE, '5215512345678') }), deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('India only') });
    expect(await count()).toBe(0);
  });

  it('a retry with the same details returns the SAME schedule (one row, one audit)', async () => {
    const a = await created();
    const b = await created();
    expect(b).toBe(a);
    expect(await count()).toBe(1);
    expect((await audits()).length).toBe(1);
  });

  it('a refusal does not stick: the same details work once the cause is fixed', async () => {
    await clearLegalName(db, 'pa', PHONE);
    const r = await createScheduleTool(principal(), monthly(), deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('full legal name') });
    await nameOnFile('pa', PHONE);
    expect(await createScheduleTool(principal(), monthly(), deps)).toMatchObject({ ok: true });
    expect(await count()).toBe(1);
  });

  it('at most 5 new repeat payments a day per customer, all apps together', async () => {
    for (let i = 0; i < 3; i++) await created(monthly({ amount: 100 + i }));
    for (let i = 3; i < 5; i++) await created(monthly({ amount: 100 + i }), principal({ grantId: 'agg_other', clientId: 'agc_gpt', clientName: 'ChatGPT' }));
    expect(await createScheduleTool(principal(), monthly({ amount: 199 }), deps)).toEqual({ ok: false, message: SCHEDULE_TOO_MANY_CREATES });
    expect(await count()).toBe(5);
    // Another customer has their own budget.
    const other = principal({ phone: OTHER_PHONE });
    expect(await createScheduleTool(other, monthly({ recipient_id: rid('pa', OTHER_PHONE, '919800000009') }), deps)).toMatchObject({ ok: true });
  });

  it('an empty or odd app name still gets a bounded label', async () => {
    const id = await created(monthly(), principal({ clientName: '' }));
    expect(await viaColumn(id)).toBe('an AI app');
  });

  it('the retry key is per connection and per detail', () => {
    const k = scheduleRequestKey('agg_a', monthly());
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(scheduleRequestKey('agg_a', monthly())).toBe(k);
    expect(scheduleRequestKey('agg_b', monthly())).not.toBe(k);
    expect(scheduleRequestKey('agg_a', monthly({ amount: 151 }))).not.toBe(k);
  });
});

describe('list_schedules', () => {
  it("lists the customer's own active and paused repeat payments, never cancelled ones or anyone else's", async () => {
    const a = await created(monthly({ amount: 101 }));
    const b = await created(monthly({ amount: 102 }));
    const c = await created(monthly({ amount: 103 }));
    await changeScheduleTool(principal(), { schedule_id: b, action: 'pause' }, deps);
    await changeScheduleTool(principal(), { schedule_id: c, action: 'cancel' }, deps);
    await created(monthly({ recipient_id: rid('pa', OTHER_PHONE, '919800000009') }), principal({ phone: OTHER_PHONE }));
    await created(monthly({ recipient_id: rid('pb', PHONE, '919800000001') }), principal({ partnerId: 'pb' }));

    const r = await listSchedulesTool(principal(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.data.schedules as Array<Record<string, unknown>>;
    expect(rows.map((s) => s.schedule_id).sort()).toEqual([a, b].sort());
    const paused = rows.find((s) => s.schedule_id === b)!;
    expect(paused).toMatchObject({ status: 'paused', next_due_date: null, set_up_in: 'Claude' });
    expect(rows.find((s) => s.schedule_id === a)!.next_due_date).toMatch(/^\d{4}-\d{2}-05$/);
    expect(r.data.how_it_works).toContain('pay link');
  });

  it('is empty for a customer with none', async () => {
    expect(await listSchedulesTool(principal(), deps)).toMatchObject({ ok: true, data: { schedules: [] } });
  });
});

describe('change_schedule', () => {
  it('pause → resume → cancel, each audited as the app; a cancelled one cannot resume', async () => {
    const id = await created();
    expect(await changeScheduleTool(principal(), { schedule_id: id, action: 'pause' }, deps)).toMatchObject({ ok: true, data: { status: 'paused', next_due_date: null }, scheduleId: id });
    expect(await changeScheduleTool(principal(), { schedule_id: id, action: 'pause' }, deps)).toEqual({ ok: false, message: 'This repeat payment is already paused.' });
    const resumed = await changeScheduleTool(principal(), { schedule_id: id, action: 'resume' }, deps);
    expect(resumed).toMatchObject({ ok: true, data: { status: 'active' } });
    if (resumed.ok) expect(resumed.data.next_due_date).toMatch(/^\d{4}-\d{2}-05$/);
    expect(await changeScheduleTool(principal(), { schedule_id: id, action: 'cancel' }, deps)).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(await changeScheduleTool(principal(), { schedule_id: id, action: 'resume' }, deps)).toMatchObject({ ok: false, message: expect.stringContaining('final') });
    const rows = await audits();
    expect(rows.map((x) => x.action)).toEqual(['schedule.create', 'schedule.pause', 'schedule.resume', 'schedule.cancel']);
    expect(rows.every((x) => x.actor === 'agent:agc_claude' && x.actor_type === 'agent')).toBe(true);
    expect(rows[1].meta).toEqual({ scheduleId: id, from: 'active', to: 'paused' });
  });

  it("isolation: another customer's or another tenant's schedule, or a made-up id, is not found; nothing changes", async () => {
    const theirs = await created(monthly({ recipient_id: rid('pa', OTHER_PHONE, '919800000009') }), principal({ phone: OTHER_PHONE }));
    const tenantB = await created(monthly({ recipient_id: rid('pb', PHONE, '919800000001') }), principal({ partnerId: 'pb' }));
    for (const schedule_id of [theirs, tenantB, 'x', 'bad id with spaces']) {
      expect(await changeScheduleTool(principal(), { schedule_id, action: 'cancel' }, deps)).toEqual({ ok: false, message: SCHEDULE_NOT_FOUND });
    }
    expect((await createScheduleRepo(db).getSchedule(theirs))?.status).toBe('active');
    expect((await createScheduleRepo(db).getSchedule(tenantB))?.status).toBe('active');
  });

  it('at most 20 changes an hour per customer', async () => {
    const id = await created();
    for (let i = 0; i < MCP_SCHEDULE_CHANGE_LIMIT.limit; i++) {
      await changeScheduleTool(principal(), { schedule_id: id, action: i % 2 === 0 ? 'pause' : 'resume' }, deps);
    }
    expect(await changeScheduleTool(principal(), { schedule_id: id, action: 'cancel' }, deps)).toEqual({ ok: false, message: SCHEDULE_TOO_MANY_CHANGES });
    expect((await createScheduleRepo(db).getSchedule(id))?.status).toBe('active');
  });
});

describe('nextDueDate (US Eastern dates)', () => {
  const base: Schedule = {
    id: 's_test01',
    phone: PHONE,
    amountUsd: 150,
    amountSource: 150,
    sourceCurrency: 'USD',
    recipientName: 'Asha',
    recipientPhone: RECIPIENT_PHONE,
    payoutMethod: 'bank',
    payoutDestination: 'x',
    fundingMethod: 'bank_transfer',
    frequency: 'monthly',
    dayOfMonth: 5,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'pa',
  };
  // Mon 2 Nov 2026, 10:00 in New York.
  const MON = Date.parse('2026-11-02T15:00:00Z');

  it('the next matching day of the month or week', () => {
    expect(nextDueDate(base, MON)).toBe('2026-11-05');
    expect(nextDueDate({ ...base, frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 3 }, MON)).toBe('2026-11-04');
  });

  it('today when due today and not yet sent; next time when already sent today', () => {
    expect(nextDueDate({ ...base, dayOfMonth: 2 }, MON)).toBe('2026-11-02');
    expect(nextDueDate({ ...base, dayOfMonth: 2, lastRunAt: '2026-11-02T13:00:00.000Z' }, MON)).toBe('2026-12-02');
  });

  it('uses the Eastern date, not the UTC date', () => {
    // 03:00 UTC on 3 Nov is still 2 Nov (22:00) in New York, so day 3 is tomorrow there.
    expect(nextDueDate({ ...base, dayOfMonth: 3 }, Date.parse('2026-11-03T03:00:00Z'))).toBe('2026-11-03');
  });

  it('null when paused, cancelled, or the end date comes first', () => {
    expect(nextDueDate({ ...base, status: 'paused' }, MON)).toBeNull();
    expect(nextDueDate({ ...base, status: 'cancelled' }, MON)).toBeNull();
    expect(nextDueDate({ ...base, endDate: '2026-11-04' }, MON)).toBeNull();
  });
});
