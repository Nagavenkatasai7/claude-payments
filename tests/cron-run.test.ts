import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDueSchedules } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Schedule } from '@/lib/types';

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

function makeScheduleStore() {
  const redis = fakeRedis();
  const store = createStore(redis);
  const cs = createCustomerStore(redis, store);
  return createScheduleStore(redis, cs);
}

// Build a complete, self-consistent set of cron deps against a single redis so
// the customerStore the cron reads is the same one tests write to.
function makeDeps() {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const scheduleStore = createScheduleStore(redis, customerStore);
  return { redis, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore };
}

describe('runDueSchedules', () => {
  it('fires a due schedule: creates a transfer, notifies, records lastRunAt', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const scheduleStore = makeScheduleStore();
    const customerStore = createCustomerStore(fakeRedis(), store); // no records ⇒ getCustomer null ⇒ not opted out
    await scheduleStore.saveSchedule(sched('due', 21));
    await scheduleStore.saveSchedule(sched('notdue', 5));
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
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
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const scheduleStore = makeScheduleStore();
    const customerStore = createCustomerStore(fakeRedis(), store); // no records ⇒ getCustomer null ⇒ not opted out
    const blocked = sched('b', 21);
    blocked.recipientName = 'John Doe'; // on the watchlist
    await scheduleStore.saveSchedule(blocked);
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(0); // blocked → no payment link sent
  });

  it('endDate in the PAST: does NOT fire the schedule and marks it cancelled', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const scheduleStore = makeScheduleStore();
    const customerStore = createCustomerStore(fakeRedis(), store); // no records ⇒ getCustomer null ⇒ not opted out
    // Schedule is due today (day 21) but its endDate is yesterday
    const pastEnded: Schedule = {
      ...sched('past-ended', 21),
      // Set endDate to a date clearly before NOW (2026-05-21)
      endDate: '2026-05-20',
    };
    await scheduleStore.saveSchedule(pastEnded);
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(0); // not fired
    expect(notified).toHaveLength(0); // no notification
    // Must be marked cancelled so it won't appear in future active-schedule queries
    const saved = await scheduleStore.getSchedule('past-ended');
    expect(saved?.status).toBe('cancelled');
  });

  it('endDate in the FUTURE: schedule still fires when due', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const scheduleStore = makeScheduleStore();
    const customerStore = createCustomerStore(fakeRedis(), store); // no records ⇒ getCustomer null ⇒ not opted out
    // Due today with an end date well in the future
    const futureEnded: Schedule = {
      ...sched('future-ended', 21),
      endDate: '2027-01-01',
    };
    await scheduleStore.saveSchedule(futureEnded);
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    // Must still be active (not cancelled prematurely)
    const saved = await scheduleStore.getSchedule('future-ended');
    expect(saved?.status).toBe('active');
  });

  it('no endDate (absent): schedule fires as usual when due', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const monthlyVolumeStore = createMonthlyVolumeStore(redis);
    const scheduleStore = makeScheduleStore();
    const customerStore = createCustomerStore(fakeRedis(), store); // no records ⇒ getCustomer null ⇒ not opted out
    // sched() helper does not set endDate — plain active schedule
    await scheduleStore.saveSchedule(sched('no-end', 21));
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    const saved = await scheduleStore.getSchedule('no-end');
    expect(saved?.status).toBe('active');
  });

  it('Item 4: SKIPS a due schedule whose owning customer is opted-out (not fired, lastRunAt untouched, still active)', async () => {
    const { store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = makeDeps();
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
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
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
    const { store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = makeDeps();
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
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
  });
});
