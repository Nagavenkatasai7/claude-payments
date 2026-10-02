import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { runDueSchedules, type CronDeps, type NameNeededTiming } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import type { KycProvider } from '@/lib/providers/kyc-provider';
import type { Schedule } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// A scheduled send that cannot go out for want of the sender's legal name now
// TELLS the customer (2026-10-02 ops alert, schedule skipped with
// sender_name_missing and the customer heard nothing):
//  - on the due day, once per schedule per Eastern day, beside the ops alert;
//  - up to 3 days BEFORE the due day, once per schedule per due date, so the
//    name can land before the run instead of after a missed one.
// A failing send never breaks the run, and nothing else about the run changes.

const PHONE = '15550007777';
const NOW = Date.parse('2026-05-21T16:00:00.000Z'); // Thu, Eastern 2026-05-21
const DAY = 24 * 60 * 60 * 1000;

const kycProvider: KycProvider = {
  startVerification: async () => ({ url: 'https://kyc.example/verify', providerRef: 'ref_1' }),
  getStatus: async () => 'pending',
  handleWebhook: async () => null,
};

let db: Db;

function sched(id: string, over: Partial<Schedule> = {}): Schedule {
  return {
    id, phone: PHONE, amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 21, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'default', sourceCurrency: 'USD', amountSource: 200,
    ...over,
  };
}

async function setup(opts: { fullName?: string; optedOut?: boolean } = {}) {
  const store = createStore(fakeRedis(), db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
    ...(opts.fullName ? { fullName: opts.fullName } : {}),
    ...(opts.optedOut ? { optedOutAt: nowIso } : {}),
  });
  const scheduleStore = createScheduleStore(db);
  const nudges: Array<{ id: string; timing: NameNeededTiming }> = [];
  const links: string[] = [];
  const deps = (now: number, over: Partial<CronDeps> = {}): CronDeps => ({
    db, store, partnerStore: createPartnerStore(db), customerStore,
    monthlyVolumeStore: createMonthlyVolumeStore(store), scheduleStore, kycProvider, now,
    sendScheduledLink: async (_s, _t, url) => { links.push(url); },
    sendScheduledNameNeeded: async (s, timing) => { nudges.push({ id: s.id, timing }); },
    ...over,
  });
  return { store, scheduleStore, nudges, links, deps };
}

async function opsAlertKeys() {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((x) => x.dedupe_key);
}

const etDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rates: { INR: 85 } }), text: async () => '' })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('due day, no legal name: the customer is told', { retry: 0 }, () => {
  it('nudges once per schedule per Eastern day; the ops alert and accounting are unchanged', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('due'));
    expect(await runDueSchedules(t.deps(NOW))).toEqual({ fired: 0, failed: 1 });
    expect(await runDueSchedules(t.deps(NOW + 4 * 60 * 60 * 1000))).toEqual({ fired: 0, failed: 1 }); // the 17:00 UTC catch-up
    expect(t.nudges).toEqual([{ id: 'due', timing: { dueToday: true, dueAt: expect.any(Number) } }]);
    expect(etDay(t.nudges[0].timing.dueAt)).toBe('2026-05-21');
    expect(t.links).toHaveLength(0);
    expect(await t.store.listTransfers()).toHaveLength(0);
    expect(await opsAlertKeys()).toEqual(['schedule-sender-name:due:2026-05-21']);
  });

  it('a failing send never breaks the run: the next schedule still fires', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('nameless'));
    // A second owner WITH a name, due the same day.
    const other = '15550008888';
    const nowIso = new Date().toISOString();
    await createCustomerStore(db, t.store).saveCustomer({
      senderPhone: other, firstSeenAt: nowIso, kycStatus: 'verified', senderCountry: 'US',
      partnerId: 'default', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName: 'Alex Rivera',
    });
    await t.scheduleStore.saveSchedule(sched('named', { phone: other }));
    const r = await runDueSchedules(t.deps(NOW, { sendScheduledNameNeeded: async () => { throw new Error('graph 470'); } }));
    expect(r).toEqual({ fired: 1, failed: 1 });
    expect(t.links).toHaveLength(1);
  });

  it('without the dep wired, the run behaves exactly as before', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('due'));
    expect(await runDueSchedules(t.deps(NOW, { sendScheduledNameNeeded: undefined }))).toEqual({ fired: 0, failed: 1 });
  });

  it('a named owner gets no name nudge', async () => {
    const t = await setup({ fullName: 'Alex Rivera' });
    await t.scheduleStore.saveSchedule(sched('due'));
    expect(await runDueSchedules(t.deps(NOW))).toEqual({ fired: 1, failed: 0 });
    expect(t.nudges).toHaveLength(0);
  });
});

describe('up to 3 days before the due day, no legal name: an early warning', { retry: 0 }, () => {
  it('warns once per due date, without counting, alerting or marking the run', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    expect(await runDueSchedules(t.deps(NOW))).toEqual({ fired: 0, failed: 0 });
    expect(await runDueSchedules(t.deps(NOW + 4 * 60 * 60 * 1000))).toEqual({ fired: 0, failed: 0 });
    expect(await runDueSchedules(t.deps(NOW + DAY))).toEqual({ fired: 0, failed: 0 }); // the next day: same due date
    expect(t.nudges).toHaveLength(1);
    expect(t.nudges[0].timing.dueToday).toBe(false);
    expect(etDay(t.nudges[0].timing.dueAt)).toBe('2026-05-23');
    expect(await opsAlertKeys()).toEqual([]);
    expect((await t.scheduleStore.getSchedule('soon'))?.lastRunAt).toBeUndefined();
  });

  it('the due day still sends its own message after an early warning', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    await runDueSchedules(t.deps(NOW));
    await runDueSchedules(t.deps(NOW + 2 * DAY));
    expect(t.nudges.map((n) => n.timing.dueToday)).toEqual([false, true]);
  });

  it('no warning when the run is more than 3 days away', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('later', { dayOfMonth: 25 }));
    await runDueSchedules(t.deps(NOW));
    expect(t.nudges).toHaveLength(0);
  });

  it('no warning for a named owner, an opted-out owner, a paused schedule or a suspended partner', async () => {
    const named = await setup({ fullName: 'Alex Rivera' });
    await named.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    await runDueSchedules(named.deps(NOW));
    expect(named.nudges).toHaveLength(0);

    db = await freshDb();
    const opted = await setup({ optedOut: true });
    await opted.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    await runDueSchedules(opted.deps(NOW));
    expect(opted.nudges).toHaveLength(0);

    db = await freshDb();
    const paused = await setup();
    await paused.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23, status: 'paused' }));
    await runDueSchedules(paused.deps(NOW));
    expect(paused.nudges).toHaveLength(0);

    db = await freshDb();
    const suspended = await setup();
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'default'`);
    await suspended.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    await runDueSchedules(suspended.deps(NOW));
    expect(suspended.nudges).toHaveLength(0);
  });

  it('a failing early warning never breaks the run', async () => {
    const t = await setup();
    await t.scheduleStore.saveSchedule(sched('soon', { dayOfMonth: 23 }));
    await expect(
      runDueSchedules(t.deps(NOW, { sendScheduledNameNeeded: async () => { throw new Error('boom'); } })),
    ).resolves.toEqual({ fired: 0, failed: 0 });
  });
});
