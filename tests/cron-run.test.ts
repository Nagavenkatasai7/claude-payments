import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { runDueSchedules } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { SendBusyError } from '@/lib/send-limits';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Schedule } from '@/lib/types';
import type { CustomerStore } from '@/lib/customer-store';
import type { KycProvider } from '@/lib/providers/kyc-provider';

// Phase 3: cron now requires a kycProvider for the verify-before-send hand-off.
const kycProvider: KycProvider = {
  startVerification: async () => ({ url: 'https://kyc.example/verify', providerRef: 'ref_1' }),
  getStatus: async () => 'pending',
  handleWebhook: async () => null,
};

// Seed a verified owner for the schedule's phone so the verify-before-send gate
// passes for the existing-behavior tests (they exercise the fire path).
async function seedVerified(cs: CustomerStore, phone = '15551234567'): Promise<void> {
  await cs.saveCustomer({
    senderPhone: phone, firstSeenAt: '2026-01-01T00:00:00Z',
    kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
}

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-05-21T16:00:00.000Z'); // day-of-month 21

function sched(id: string, dayOfMonth: number): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'default',
    sourceCurrency: 'USD',
    amountSource: 200,
  };
}

// Build a complete, self-consistent set of cron deps against a single redis
// AND a single fresh Postgres handle (freshDb truncates per call, so every
// pg-backed store in a test must share the one db).
async function makeDeps() {
  const redis = fakeRedis();
  const db = await freshDb(); // truncates + reseeds the 'default' partner
  const store = createStore(redis, db);
  const partnerStore = createPartnerStore(db);
  const monthlyVolumeStore = createMonthlyVolumeStore(store);
  const customerStore = createCustomerStore(db, store);
  const scheduleStore = createScheduleStore(db);
  return { redis, db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore };
}

describe('runDueSchedules', () => {
  it('fires a due schedule: creates a transfer, notifies, records lastRunAt', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // Phase 3: verified owner so the verify-before-send gate passes
    await scheduleStore.saveSchedule(sched('due', 21));
    await scheduleStore.saveSchedule(sched('notdue', 5));
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('/pay/');
    expect((await store.listTransfers())).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
    expect((await scheduleStore.getSchedule('notdue'))?.lastRunAt).toBeUndefined();
  });

  it('does not notify when the created transfer is compliance-blocked', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // Phase 3: verified owner so the verify-before-send gate passes
    const blocked = sched('b', 21);
    blocked.recipientName = 'John Doe'; // on the watchlist
    await scheduleStore.saveSchedule(blocked);
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(0); // blocked → no payment link sent
  });

  it('endDate in the PAST: does NOT fire the schedule and marks it cancelled', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // Phase 3: verified owner so the verify-before-send gate passes
    // Schedule is due today (day 21) but its endDate is yesterday
    const pastEnded: Schedule = {
      ...sched('past-ended', 21),
      // Set endDate to a date clearly before NOW (2026-05-21)
      endDate: '2026-05-20',
    };
    await scheduleStore.saveSchedule(pastEnded);
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(0); // not fired
    expect(notified).toHaveLength(0); // no notification
    // Must be marked cancelled so it won't appear in future active-schedule queries
    const saved = await scheduleStore.getSchedule('past-ended');
    expect(saved?.status).toBe('cancelled');
  });

  it('endDate in the FUTURE: schedule still fires when due', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // Phase 3: verified owner so the verify-before-send gate passes
    // Due today with an end date well in the future
    const futureEnded: Schedule = {
      ...sched('future-ended', 21),
      endDate: '2027-01-01',
    };
    await scheduleStore.saveSchedule(futureEnded);
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    // Must still be active (not cancelled prematurely)
    const saved = await scheduleStore.getSchedule('future-ended');
    expect(saved?.status).toBe('active');
  });

  it('no endDate (absent): schedule fires as usual when due', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // Phase 3: verified owner so the verify-before-send gate passes
    // sched() helper does not set endDate — plain active schedule
    await scheduleStore.saveSchedule(sched('no-end', 21));
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    const saved = await scheduleStore.getSchedule('no-end');
    expect(saved?.status).toBe('active');
  });

  it('Item 4: SKIPS a due schedule whose owning customer is opted-out (not fired, lastRunAt untouched, still active)', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await scheduleStore.saveSchedule(sched('opted-out', 21));
    // Save the owning customer with optedOutAt set
    await customerStore.saveCustomer({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      optedOutAt: '2026-05-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(0);
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0); // no transfer created
    const saved = await scheduleStore.getSchedule('opted-out');
    expect(saved?.status).toBe('active'); // stays active — resumes on START
    expect(saved?.lastRunAt).toBeUndefined(); // not touched
  });

  it('Item 4: an owner who is NOT opted-out (no optedOutAt) still fires', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await scheduleStore.saveSchedule(sched('opted-in', 21));
    await customerStore.saveCustomer({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      optInAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
  });

  it('Phase 3: SKIPS a due schedule whose owner is unverified — no transfer, lastRunAt untouched, sendScheduledSkipped called once', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    // The gate is partner OPT-IN now — configure it so the skip path applies.
    const dflt = await partnerStore.ensureDefaultPartner();
    await partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    await scheduleStore.saveSchedule(sched('unverified', 21));
    await customerStore.saveCustomer({
      senderPhone: '15551234567', firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'grandfathered', senderCountry: 'US', partnerId: 'default',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    const notified: string[] = [];
    const skipped: { id: string; url: string }[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
      sendScheduledSkipped: async (s, _owner, url) => { skipped.push({ id: s.id, url }); },
    });

    expect(result.fired).toBe(0);
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0); // no transfer minted
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe('unverified');
    expect(skipped[0].url).toContain('kyc.example');
    const saved = await scheduleStore.getSchedule('unverified');
    expect(saved?.status).toBe('active');           // stays active — resumes once verified
    expect(saved?.lastRunAt).toBeUndefined();        // not bumped
    // Review item 1: the minted inquiry is recorded on the schedule's (tenant, phone) row
    // so the Persona completion can bind to it once the phone has sibling rows.
    expect((await customerStore.getCustomer('default', '15551234567'))?.kycInquiryId).toBe('ref_1');
  });
});

describe('runDueSchedules — a refused scheduled send is loud (Task 9)', () => {
  // The daily cron (vercel.json "0 13 * * *") has no catch-up — isScheduleDueToday
  // matches the day exactly — so a refused run must page ops, not just log.
  async function opsAlerts(db: Awaited<ReturnType<typeof makeDeps>>['db']) {
    const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> }).rows;
  }

  it('FX unavailable ⇒ not fired, counted, logged (scrubbed), ONE ops.alert keyed schedule-refused:<id>:<day>; lastRunAt untouched', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toHaveLength(0);
    expect(await store.getTransferCount('default', '15551234567')).toBe(0);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    const lines = errors.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes('"scope":"cron.schedule-run"') && l.includes('"reason":"fetch_failed"'))).toBe(true);
    const alerts = await opsAlerts(db);
    expect(alerts.map((a) => a.dedupe_key)).toEqual(['schedule-refused:due:2026-05-21']); // NOW, Eastern day
    expect(alerts[0].payload.message).toContain('due');
    expect(alerts[0].payload.message).toContain('fetch_failed');
    expect(alerts[0].payload.message).not.toMatch(/\d{7,}/); // never the customer's phone
  });

  it('a same-day re-run that is refused again adds NO second alert (dedupe) but is still counted', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    };

    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect(await opsAlerts(db)).toHaveLength(1);
  });

  it('a clean run reports failed: 0 and raises no alert (the result shape is { fired, failed })', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(await opsAlerts(db)).toHaveLength(0);
  });
});

describe('runDueSchedules — pre-fix schedules (fix 6 / ctx-01)', () => {
  async function runOnly(schedule: Schedule) {
    // (db: Task 9 made the cron's ops-alert outbox a dependency — every caller passes it.)
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(schedule);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    return { result, notified, store, scheduleStore };
  }

  it('a masked destination is NOT fired: no transfer, no link, counted in failed, lastRunAt untouched', async () => {
    const { result, notified, store, scheduleStore } = await runOnly({ ...sched('masked', 21), payoutMethod: 'bank', payoutDestination: '****9012' });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    expect((await scheduleStore.getSchedule('masked'))?.lastRunAt).toBeUndefined();
  });

  it('a partner-pulled funding method is NOT fired (a consumer row would never be charged)', async () => {
    const { result, store } = await runOnly({ ...sched('pulled', 21), fundingMethod: 'bank_pull' });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(await store.listTransfers()).toHaveLength(0);
  });
});

// ── Program fix 16 (Task 10, test 13): cron mints are capped from the ledger ──
describe('runDueSchedules — send cap (Program fix 16)', () => {
  it('an owner at their cap ⇒ failed:1, no transfer, ONE deduped schedule-refused alert with send_cap, lastRunAt untouched', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore); // firstSeenAt 2026-01-01 ⇒ T1 ($2,999/day)
    await scheduleStore.saveSchedule(sched('due', 21)); // $200
    await seedLedgerSpend(db, { partnerId: 'default', phone: '15551234567', amountUsd: 2900, status: 'paid' }); // $2,900 today
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toEqual([]);
    expect(await store.listTransfers()).toHaveLength(1); // the seeded row only
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    const alerts = (r as unknown as { rows: { dedupe_key: string; payload: { message: string } }[] }).rows;
    expect(alerts.map((a) => a.dedupe_key)).toEqual(['schedule-refused:due:2026-05-21']);
    expect(alerts[0].payload.message).toContain('(send_cap)');
    expect(alerts[0].payload.message).not.toMatch(/2,?900|2,?999/); // no figures
  });
});

describe('runDueSchedules — busy sender lock (review SHOULD 6)', () => {
  it('a SendBusyError is retried ONCE in-process (nothing was written): the retry fires the schedule', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    const real = store.mintUnderSenderLock.bind(store);
    const spy = vi.spyOn(store, 'mintUnderSenderLock').mockRejectedValueOnce(new SendBusyError()).mockImplementation(real);
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(notified).toHaveLength(1);
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
  });

  it('busy twice ⇒ failed:1 with reason busy, no transfer, one deduped alert', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(store, 'mintUnderSenderLock').mockRejectedValue(new SendBusyError());
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(await store.listTransfers()).toHaveLength(0);
    const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`);
    const alerts = (r as unknown as { rows: { dedupe_key: string; payload: { message: string } }[] }).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.message).toContain('(busy)');
  });
});

// Program-Fix 36 (schedules-02): the staff kill switch and the partner gate.
// A paused schedule never fires; a suspended (or missing) partner's schedules
// never fire and page ops once per partner per Eastern day; a pause landing
// mid-run is honoured by a pre-mint re-read; and the cron's writes are
// column-targeted, so they can never resurrect a paused row.
describe('runDueSchedules — kill switch + partner gate (Program-Fix 36)', () => {
  async function opsAlerts(db: Awaited<ReturnType<typeof makeDeps>>['db']) {
    const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> }).rows;
  }

  it('test 4: a due PAUSED schedule gives fired 0, no transfer, lastRunAt unchanged', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule({ ...sched('due', 21), status: 'paused' });
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    const row = await scheduleStore.getSchedule('due');
    expect(row?.status).toBe('paused');
    expect(row?.lastRunAt).toBeUndefined();
  });

  it('test 5a: a SUSPENDED partner: no transfer, no lastRunAt, exactly ONE schedule-suspended:<partnerId>:<day> alert across two runs; not counted as failed', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    await scheduleStore.saveSchedule(sched('due2', 21));
    const partner = (await partnerStore.getPartner('default'))!;
    await partnerStore.savePartner({ ...partner, status: 'suspended' });
    const notified: string[] = [];
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => { notified.push(url); },
    };
    const first = await runDueSchedules(deps);
    const second = await runDueSchedules(deps);
    expect(first).toEqual({ fired: 0, failed: 0 });
    expect(second).toEqual({ fired: 0, failed: 0 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    expect((await scheduleStore.getSchedule('due2'))?.lastRunAt).toBeUndefined();
    // Both schedules stay ACTIVE — reactivating the partner resumes them with no data change.
    expect((await scheduleStore.getSchedule('due'))?.status).toBe('active');
    const alerts = await opsAlerts(db);
    expect(alerts.map((a) => a.dedupe_key)).toEqual(['schedule-suspended:default:2026-05-21']);
    expect(alerts[0].payload.message).toContain('default');
    expect(alerts[0].payload.message).not.toMatch(/\d{7,}/); // never the customer's phone
  });

  it('test 5b: a MISSING partner row is skipped the same way (fail closed, no default fallback)', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    // schedules.partner_id FKs partners.id, so the row cannot be deleted in
    // PGlite — stub the read instead.
    const missing = { ...partnerStore, getPartner: async () => null };
    const ensureDefault = vi.spyOn(missing, 'ensureDefaultPartner');
    const result = await runDueSchedules({
      db, store, partnerStore: missing, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(ensureDefault).not.toHaveBeenCalled();
    expect(await store.listTransfers()).toHaveLength(0);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    expect((await opsAlerts(db)).map((a) => a.dedupe_key)).toEqual(['schedule-suspended:default:2026-05-21']);
  });

  it('test 5c: reactivating the partner lets the next due run fire', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    const partner = (await partnerStore.getPartner('default'))!;
    await partnerStore.savePartner({ ...partner, status: 'suspended' });
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 0 });
    await partnerStore.savePartner({ ...partner, status: 'active' });
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
  });

  it('test 6: a pause landing between listActiveSchedules and the mint is honoured (pre-mint re-read): no transfer', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    // The list read returns the row as active; staff pause it right after.
    const racing = {
      ...scheduleStore,
      listActiveSchedules: async () => {
        const rows = await scheduleStore.listActiveSchedules();
        await scheduleStore.setStatusIf('due', 'default', ['active'], 'paused');
        return rows;
      },
    };
    const notified: string[] = [];
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore: racing, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    const row = await scheduleStore.getSchedule('due');
    expect(row?.status).toBe('paused');
    expect(row?.lastRunAt).toBeUndefined();
  });

  it('test 7: no resurrection — the fired bump touches only last_run_at, and the end-date cancel is conditional', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    await scheduleStore.saveSchedule({ ...sched('ended', 21), endDate: '2026-05-20' });
    // Staff pause BOTH rows after the cron's list read (the cron holds stale
    // 'active' copies of each).
    const racing = {
      ...scheduleStore,
      listActiveSchedules: async () => {
        const rows = await scheduleStore.listActiveSchedules();
        await scheduleStore.setStatusIf('due', 'default', ['active'], 'paused');
        await scheduleStore.setStatusIf('ended', 'default', ['active'], 'paused');
        return rows;
      },
    };
    const saveSpy = vi.spyOn(racing, 'saveSchedule');
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore: racing, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(result).toEqual({ fired: 0, failed: 0 });
    // The cron never writes a whole row any more.
    expect(saveSpy).not.toHaveBeenCalled();
    // The paused-after-read row is still paused (the re-read skipped it)…
    expect((await scheduleStore.getSchedule('due'))?.status).toBe('paused');
    // …and the end-dated row, paused after the read, was NOT cancelled by a
    // whole-row upsert from the stale copy: the conditional cancel (from
    // 'active' only) lost the race and wrote nothing.
    expect((await scheduleStore.getSchedule('ended'))?.status).toBe('paused');
  });

  it('test 7b: the end-date cancel still lands through setStatusIf when the row IS active', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule({ ...sched('ended', 21), endDate: '2026-05-20' });
    const setSpy = vi.spyOn(scheduleStore, 'setStatusIf');
    await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(setSpy).toHaveBeenCalledWith('ended', 'default', ['active'], 'cancelled');
    expect((await scheduleStore.getSchedule('ended'))?.status).toBe('cancelled');
  });
});

// Program-Fix 32 (neon-08): the cron mint is CLAIM-FIRST. The key
// sched:<scheduleId>:<YYYY-MM-DD Eastern day> is bound (under the schedule's partner)
// to a pre-generated id BEFORE createTransfer, so a same-day replay re-mints
// the SAME row or finds it — at most one transfer per schedule per Eastern day.
describe('runDueSchedules — claim-first replay safety (Program-Fix 32)', () => {
  async function schedKeys(db: Awaited<ReturnType<typeof makeDeps>>['db']) {
    const r = await db.execute(sql`SELECT partner_id, key, transfer_id FROM idempotency_keys WHERE key LIKE 'sched:%' ORDER BY created_at, key`);
    return (r as unknown as { rows: Array<{ partner_id: string; key: string; transfer_id: string }> }).rows;
  }

  it('test 1: a replay after a FAILED link send mints nothing new — one transfer, key bound to it, same link re-sent, lastRunAt set', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: string[] = [];
    let failSend = true;
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, t: { id: string }, url: string) => {
        if (failSend) throw new Error('graph api down');
        sent.push(`${t.id} ${url}`);
      },
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    failSend = false;
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });

    const transfers = await store.listTransfers();
    expect(transfers).toHaveLength(1);
    const keys = await schedKeys(db);
    expect(keys).toEqual([{ partner_id: 'default', key: 'sched:due:2026-05-21', transfer_id: transfers[0].id }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`/pay/${transfers[0].id}`);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
  });

  it('test 2: two concurrent runs give ONE transfer', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    };
    await Promise.all([runDueSchedules(deps), runDueSchedules(deps)]);
    const transfers = await store.listTransfers();
    expect(transfers).toHaveLength(1);
    expect((await schedKeys(db)).map((k) => k.transfer_id)).toEqual([transfers[0].id]);
  });

  it('test 3: a REFUSED mint (FX unavailable) leaves the key bound and no row; a same-day re-run after the cause clears mints THAT id', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const notified: string[] = [];
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => { notified.push(url); },
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    const [bound] = await schedKeys(db);
    expect(bound.key).toBe('sched:due:2026-05-21');
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await store.getTransfer(bound.transfer_id)).toBeNull();

    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    const transfers = await store.listTransfers();
    expect(transfers.map((t) => t.id)).toEqual([bound.transfer_id]);
    expect(notified).toEqual([expect.stringContaining(`/pay/${bound.transfer_id}`)]);
    expect(await schedKeys(db)).toHaveLength(1);
  });

  it('test 4: the next due day gets a NEW key and a second transfer', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    const base = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider,
      sendScheduledLink: async () => {},
    };
    const nextDue = NOW + 31 * 86_400_000; // May has 31 days ⇒ the 21st of the next month, same hour
    const easternDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    expect(await runDueSchedules({ ...base, now: NOW })).toEqual({ fired: 1, failed: 0 });
    expect(await runDueSchedules({ ...base, now: nextDue })).toEqual({ fired: 1, failed: 0 });
    const keys = await schedKeys(db);
    expect(keys.map((k) => k.key)).toEqual([
      `sched:due:${easternDay(NOW)}`,
      `sched:due:${easternDay(nextDue)}`,
    ]);
    expect(new Set(keys.map((k) => k.transfer_id)).size).toBe(2);
    expect(await store.listTransfers()).toHaveLength(2);
  });

  it('test 5b: a replay onto a row that is no longer awaiting payment (e.g. cancelled) sends no link and still records lastRunAt', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failSend = true;
    const notified: string[] = [];
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => {
        if (failSend) throw new Error('graph api down');
        notified.push(url);
      },
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    const [t] = await store.listTransfers();
    await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${t.id}`); // staff cancelled it
    failSend = false;
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
  });

  async function replayOnto(mutate: (db: Awaited<ReturnType<typeof makeDeps>>['db'], id: string) => Promise<void>) {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failSend = true;
    const notified: string[] = [];
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => {
        if (failSend) throw new Error('graph api down');
        notified.push(url);
      },
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    const [t] = await store.listTransfers();
    await mutate(db, t.id);
    failSend = false;
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
    return notified;
  }

  it('review S5: a replay onto a PAID row sends no link', async () => {
    const notified = await replayOnto(async (db, id) => {
      await db.execute(sql`UPDATE transfers SET status = 'paid', paid_at = now(), funding_ref = 'mockfund-x' WHERE id = ${id}`);
    });
    expect(notified).toHaveLength(0);
  });

  it('review S4: a replay onto an awaiting row that is already CHARGED (funding_ref set) sends no link', async () => {
    const notified = await replayOnto(async (db, id) => {
      await db.execute(sql`UPDATE transfers SET funding_ref = 'mockfund-x' WHERE id = ${id}`);
    });
    expect(notified).toHaveLength(0);
  });

  it('test 5: a replay onto an existing BLOCKED row sends no link and still records lastRunAt', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule({ ...sched('b', 21), recipientName: 'John Doe' }); // on the watchlist
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The first run mints the blocked row, then dies before recording the run.
    vi.spyOn(scheduleStore, 'markRun').mockRejectedValueOnce(new Error('db blip'));
    const notified: string[] = [];
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => { notified.push(url); },
    };
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    const transfers = await store.listTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].status).toBe('blocked');
    expect(notified).toHaveLength(0);
    expect((await scheduleStore.getSchedule('b'))?.lastRunAt).toBeTruthy();
  });
});
