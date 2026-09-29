import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { runDueSchedules } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { deleteRecipientWithSchedules, recipientRid } from '@/lib/portal-recipients';
import type { KycProvider } from '@/lib/providers/kyc-provider';
import type { Customer, Schedule } from '@/lib/types';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// UI redesign M2-10, the #398 review follow-up L2: a customer deletes a saved recipient (tombstone +
// cancel of that recipient's schedules, one transaction) while a scheduled run for that recipient is
// between its status re-read and the mint. Before this fix the run minted from the now-cancelled
// schedule AND its address-book refresh un-deleted the recipient. Now the mint re-checks the schedule
// inside the locked mint transaction (FOR SHARE), and a scheduled mint's address-book refresh never
// clears a tombstone. The bot and the pay page keep their un-delete (owner O5).

const PHONE = '15550004444';
const MOM = '919876543210';
const BANK = '123456789012|HDFC0001234';
const kycProvider: KycProvider = {
  startVerification: async () => ({ url: 'https://kyc.example/verify', providerRef: 'ref_1' }),
  getStatus: async () => 'pending',
  handleWebhook: async () => null,
};

let db: Db;
let now: number;

const easternWeekday = (t: number) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Date(t).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }));

async function setup(opts: { saveRecipient?: boolean; schedulePayout?: string } = {}) {
  const store = createStore(fakeRedis(), db);
  const customerStore = createCustomerStore(db, store);
  const iso = new Date(now - 30 * 86_400_000).toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: iso, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default', optInAt: iso,
    fullName: 'Alex Rivera', createdAt: iso, updatedAt: iso,
  } as Customer);
  if (opts.saveRecipient !== false) {
    await store.upsertRecipient('default', PHONE, { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: BANK, lastUsedAt: iso });
  }
  const scheduleStore = createScheduleStore(db);
  const schedule: Schedule = {
    id: 'sched_race_1', phone: PHONE, amountUsd: 100, recipientName: 'Mom', recipientPhone: MOM, payoutMethod: 'bank',
    payoutDestination: opts.schedulePayout ?? BANK, fundingMethod: 'bank_transfer', frequency: 'weekly', dayOfWeek: easternWeekday(now),
    status: 'active', createdAt: iso, partnerId: 'default', sourceCurrency: 'USD', amountSource: 100,
  };
  await scheduleStore.saveSchedule(schedule);
  const links: string[] = [];
  const deps = {
    db, store, partnerStore: createPartnerStore(db), customerStore, monthlyVolumeStore: createMonthlyVolumeStore(store),
    scheduleStore, kycProvider, now, sendScheduledLink: async (_s: Schedule, _t: unknown, url: string) => { links.push(url); },
  };
  return { store, scheduleStore, schedule, deps, links };
}

const rid = () => recipientRid('default', PHONE, MOM);
const transfers = async () =>
  ((await db.execute(sql`SELECT id, status FROM transfers WHERE phone = ${PHONE}`)) as unknown as { rows: Array<{ id: string; status: string }> }).rows;
const tombstones = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM recipient_tombstones WHERE sender_phone = ${PHONE}`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
const scheduleStatus = async () =>
  ((await db.execute(sql`SELECT status FROM schedules WHERE id = 'sched_race_1'`)) as unknown as { rows: Array<{ status: string }> }).rows[0].status;
const liveBook = () => createRecipientRepo(db).listAllForSender('default', PHONE);
const alerts = async () =>
  ((await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((r) => r.dedupe_key);

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  now = Date.now();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('L2: a recipient delete racing a scheduled run', () => {
  it('delete lands after the status re-read, before the mint: nothing is minted and the recipient stays deleted', async () => {
    const { scheduleStore, deps, links } = await setup();
    const realGet = scheduleStore.getSchedule.bind(scheduleStore);
    vi.spyOn(scheduleStore, 'getSchedule').mockImplementation(async (id: string) => {
      const stale = await realGet(id); // the run's re-read sees 'active' …
      expect((await deleteRecipientWithSchedules(db, 'default', PHONE, rid())).ok).toBe(true); // … then the delete commits
      return stale;
    });
    const r = await runDueSchedules(deps);
    expect(r).toEqual({ fired: 0, failed: 0 }); // an inactive schedule is skipped silently, like the re-read
    expect(await transfers()).toEqual([]);
    expect(links).toEqual([]);
    expect(await scheduleStatus()).toBe('cancelled');
    expect(await tombstones()).toBe(1);
    expect(await liveBook()).toEqual([]);
  });

  it('delete lands after the mint commits, before the address-book refresh: the tombstone survives the refresh', async () => {
    const { store, deps } = await setup();
    const realUpsert = store.upsertRecipient.bind(store);
    let raced = false;
    vi.spyOn(store, 'upsertRecipient').mockImplementation(async (...args: Parameters<typeof store.upsertRecipient>) => {
      if (!raced) {
        raced = true;
        expect((await deleteRecipientWithSchedules(db, 'default', PHONE, rid())).ok).toBe(true);
      }
      return realUpsert(...args);
    });
    const r = await runDueSchedules(deps);
    expect(raced).toBe(true);
    expect(r.fired).toBe(1); // minted before the delete: an unpaid pay link, nothing moves unpaid
    expect((await transfers()).map((t) => t.status)).toEqual(['awaiting_payment']);
    expect(await scheduleStatus()).toBe('cancelled');
    expect(await tombstones()).toBe(1);
    expect(await liveBook()).toEqual([]);
  });

  it('a schedule still carrying an account for a deleted recipient mints nothing: counted, one deduped ops alert', async () => {
    const { store, deps } = await setup();
    await store.tombstoneRecipient('default', PHONE, MOM); // deleted, schedule not (yet) cancelled
    const r = await runDueSchedules(deps);
    expect(r).toEqual({ fired: 0, failed: 1 });
    expect(await transfers()).toEqual([]);
    expect(await tombstones()).toBe(1);
    expect((await alerts()).filter((k) => k.startsWith('schedule-refused:sched_race_1:'))).toHaveLength(1);
  });

  it('bot parity: a schedule with no stored account to a deleted recipient still mints (the pay page collects the account)', async () => {
    const { store, deps } = await setup({ schedulePayout: '' });
    await store.tombstoneRecipient('default', PHONE, MOM);
    const r = await runDueSchedules(deps);
    expect(r).toEqual({ fired: 1, failed: 0 });
    expect(await tombstones()).toBe(1);
  });

  it('an ordinary scheduled run still refreshes the address book', async () => {
    const { deps } = await setup();
    const before = (await liveBook())[0].lastUsedAt;
    expect(await runDueSchedules(deps)).toEqual({ fired: 1, failed: 0 });
    const after = await liveBook();
    expect(after).toHaveLength(1);
    expect(Date.parse(after[0].lastUsedAt)).toBeGreaterThan(Date.parse(before));
  });

  it('the default upsert (pay page, bot) still un-deletes (owner O5); the keep-tombstone refresh does not', async () => {
    const { store } = await setup();
    await store.tombstoneRecipient('default', PHONE, MOM);
    const r = { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank' as const, payoutDestination: BANK, lastUsedAt: new Date().toISOString() };
    await store.upsertRecipient('default', PHONE, r, { keepTombstone: true });
    expect(await tombstones()).toBe(1);
    await store.upsertRecipient('default', PHONE, r);
    expect(await tombstones()).toBe(0);
  });

  it('a scheduled refresh never reverts an edited account: an existing row only gets lastUsedAt; a missing row is inserted', async () => {
    const { store } = await setup();
    const edited = '000099990000 HDFC0000009';
    // The customer edits the account after the schedule was created (the schedule keeps the old one).
    await createRecipientRepo(db).updateLiveRecipient('default', PHONE, { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: edited, lastUsedAt: new Date(0).toISOString() });
    const later = new Date().toISOString();
    await store.upsertRecipient('default', PHONE, { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: BANK, lastUsedAt: later }, { keepTombstone: true });
    const row = await createRecipientRepo(db).getRecipient('default', PHONE, MOM);
    expect(row?.payoutDestination).toBe(edited);
    expect(row?.lastUsedAt).toBe(later);
    // A recipient not in the book yet is still saved in full.
    const NEW = '919000000077';
    await store.upsertRecipient('default', PHONE, { name: 'New', recipientPhone: NEW, payoutMethod: 'bank', payoutDestination: BANK, lastUsedAt: later }, { keepTombstone: true });
    expect((await createRecipientRepo(db).getRecipient('default', PHONE, NEW))?.payoutDestination).toBe(BANK);
  });
});
