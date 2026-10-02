import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { recipientRid } from '@/lib/portal-recipients';
import {
  createPortalSchedule,
  describeSchedule,
  isScheduleId,
  parseScheduleForm,
  recordScheduleAudit,
  setPortalScheduleStatus,
  visibleSchedules,
} from '@/lib/portal-schedules';
import { executeTool, type ToolContext } from '@/lib/tools';
import type { Customer, Schedule } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedSender, clearLegalName } from './helpers-db';
import { seedTwoPartners, TWO_PARTNER_PHONE, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-10: the customer portal's schedules library. Creates go through the bot's own
// validation (validateScheduleInput) plus the portal's two opt-in checks; status changes go through
// the ONE transition table (decideScheduleAction) and the conditional writer (setStatusIf); every
// change is audited in the same transaction, ids and states only.

const PHONE = TWO_PARTNER_PHONE;
const A_RP = '919000000001'; // pa's saved recipient in the fixture
const B_RP = '919000000002'; // pb's
const OTHER = '14155550303';

let db: Db;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;

function ctxFor(partnerId: string, phone = PHONE): ToolContext {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  return {
    phone, partnerId, store, scheduleStore: createScheduleStore(db), draftStore: createDraftStore(redis), turn: { isNewConversation: false },
    customerStore, dailyVolumeStore: createDailyVolumeStore(store), monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'), partnerStore: createPartnerStore(db), channel: 'web',
  };
}

async function nameOnFile(partnerId: string, phone = PHONE) {
  const cs = createCustomerStore(db, createStore(fakeRedis(), db));
  const c = (await cs.getCustomer(partnerId, phone)) as Customer;
  await cs.saveCustomer({ ...c, fullName: 'Alex Rivera' });
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const good = (rid: string, o: Record<string, string> = {}) =>
  parseScheduleForm(form({ rid, amount: '150', frequency: 'monthly', dayOfMonth: '5', ...o }));
const audits = async () =>
  ((await db.execute(sql`SELECT action, partner_id, subject_id, meta FROM audit_events WHERE action LIKE 'schedule.%' ORDER BY id`)) as unknown as {
    rows: Array<{ action: string; partner_id: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
const count = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM schedules`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;

beforeEach(async () => {
  db = await freshDb();
  ({ A, B } = await seedTwoPartners(db));
  await nameOnFile('pa');
  await nameOnFile('pb');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no FX at schedule set-up'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getOwnedSchedule (repo)', () => {
  it('returns only the (partner, phone) owner\'s schedule; another tenant, customer or id is null', async () => {
    const repo = createScheduleRepo(db);
    expect((await repo.getOwnedSchedule('pa', PHONE, A.scheduleIds[0]))?.id).toBe(A.scheduleIds[0]);
    expect(await repo.getOwnedSchedule('pa', PHONE, B.scheduleIds[0])).toBeNull();
    expect(await repo.getOwnedSchedule('pb', PHONE, A.scheduleIds[0])).toBeNull();
    expect(await repo.getOwnedSchedule('pa', OTHER, A.scheduleIds[0])).toBeNull();
    expect(await repo.getOwnedSchedule('pa', PHONE, 'nope')).toBeNull();
  });
});

describe('parseScheduleForm', () => {
  it('reads a monthly and a weekly form; refuses bad input field by field', () => {
    const rid = recipientRid('pa', PHONE, A_RP);
    expect(good(rid)).toEqual({ ok: true, value: { rid, amount: 150, frequency: 'monthly', dayOfMonth: 5, dayOfWeek: undefined, endDate: undefined } });
    expect(good(rid, { frequency: 'weekly', dayOfWeek: '0', dayOfMonth: '' })).toEqual({
      ok: true, value: { rid, amount: 150, frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 0, endDate: undefined },
    });
    const bad = parseScheduleForm(form({ rid: 'x', amount: '1e3', frequency: 'daily', dayOfMonth: '31', endDate: 'soon' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['amount', 'day', 'endDate', 'frequency', 'recipient']);
    const past = parseScheduleForm(form({ rid, amount: '20', frequency: 'monthly', dayOfMonth: '3', endDate: '2001-01-01' }));
    expect(past.ok).toBe(false);
  });

  it('accepts a future end date as YYYY-MM-DD', () => {
    const d = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const r = good(recipientRid('pa', PHONE, A_RP), { endDate: d });
    expect(r.ok && r.value.endDate).toBe(d);
  });
});

describe('createPortalSchedule', () => {
  it('creates from the SAVED recipient (name, number and account from the row) and audits in the same transaction', async () => {
    const parsed = good(recipientRid('pa', PHONE, A_RP));
    if (!parsed.ok) throw new Error('form');
    const r = await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, parsed.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await createScheduleRepo(db).getOwnedSchedule('pa', PHONE, r.scheduleId);
    expect(s).toMatchObject({
      partnerId: 'pa', phone: PHONE, recipientPhone: A_RP, recipientName: 'Recipient PA', payoutMethod: 'bank',
      payoutDestination: '000011112222|HDFC0001111', amountSource: 150, sourceCurrency: 'USD', frequency: 'monthly', dayOfMonth: 5, status: 'active',
      fundingMethod: 'bank_transfer',
    });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'schedule.create', partner_id: 'pa', meta: { scheduleId: r.scheduleId } });
    expect(a[0].subject_id).not.toContain(PHONE);
  });

  it("isolation: B's rid, another customer's rid, a random rid → not_found, nothing written", async () => {
    await seedSender(db, { partnerId: 'pa', phone: OTHER, firstSeenDaysAgo: 5, kycStatus: 'verified' });
    await createRecipientRepo(db).upsertRecipient('pa', OTHER, { name: 'X', recipientPhone: '919000000077', payoutMethod: 'bank', payoutDestination: '000099998888|HDFC0009999', lastUsedAt: new Date().toISOString() });
    const before = await count();
    for (const rid of [recipientRid('pb', PHONE, B_RP), recipientRid('pa', OTHER, '919000000077'), '0'.repeat(32)]) {
      const parsed = good(rid);
      if (!parsed.ok) throw new Error('form');
      expect(await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, parsed.value)).toEqual({ ok: false, code: 'not_found' });
    }
    expect(await count()).toBe(before);
    expect(await audits()).toEqual([]);
  });

  it('a deleted (tombstoned) recipient is not_found; nothing written', async () => {
    await createRecipientRepo(db).tombstoneRecipient('pa', PHONE, A_RP);
    const parsed = good(recipientRid('pa', PHONE, A_RP));
    if (!parsed.ok) throw new Error('form');
    const before = await count();
    expect(await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, parsed.value)).toEqual({ ok: false, code: 'not_found' });
    expect(await count()).toBe(before);
  });

  it('bot rules apply: a non-Indian recipient is corridor, a missing legal name is sender_name, an out-of-range amount is amount', async () => {
    await createRecipientRepo(db).upsertRecipient('pa', PHONE, { name: 'Uncle', recipientPhone: '5215512345678', payoutMethod: 'bank', payoutDestination: '012345678901234567', lastUsedAt: new Date().toISOString() });
    const mx = good(recipientRid('pa', PHONE, '5215512345678'));
    if (!mx.ok) throw new Error('form');
    expect(await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, mx.value)).toEqual({ ok: false, code: 'corridor' });
    const big = good(recipientRid('pa', PHONE, A_RP), { amount: '5000' });
    if (!big.ok) throw new Error('form');
    expect(await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, big.value)).toEqual({ ok: false, code: 'amount' });
    await clearLegalName(db, 'pa', PHONE);
    const ok = good(recipientRid('pa', PHONE, A_RP));
    if (!ok.ok) throw new Error('form');
    expect(await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, ok.value)).toEqual({ ok: false, code: 'sender_name' });
  });
});

describe('bot parity', () => {
  it('the portal saves the SAME schedule row the bot saves for the same recipient, amount and day', async () => {
    const bot = await executeTool('create_schedule', {
      amount_source: 150, funding_method: 'bank_transfer', recipient_name: 'Recipient PA', recipient_phone: A_RP,
      frequency: 'monthly', day_of_month: 5,
    }, { ...ctxFor('pa'), channel: 'whatsapp' });
    expect(bot.error).toBeUndefined();
    const parsed = good(recipientRid('pa', PHONE, A_RP));
    if (!parsed.ok) throw new Error('form');
    const web = await createPortalSchedule(db, ctxFor('pa'), 'pa', PHONE, parsed.value);
    if (!web.ok) throw new Error('web create');
    const repo = createScheduleRepo(db);
    const strip = (x: Schedule | null) => {
      const { id: _i, createdAt: _c, ...rest } = x!;
      return rest;
    };
    expect(strip(await repo.getOwnedSchedule('pa', PHONE, web.scheduleId))).toEqual(strip(await repo.getOwnedSchedule('pa', PHONE, String(bot.schedule_id))));
  });
});

describe('create racing a recipient delete (review LOW 2)', () => {
  it('a delete that commits after validation read the recipient: the create writes nothing (not_found)', async () => {
    const ctx = ctxFor('pa');
    const realList = ctx.store.listRecipients.bind(ctx.store);
    vi.spyOn(ctx.store, 'listRecipients').mockImplementation(async (...a: Parameters<typeof ctx.store.listRecipients>) => {
      const stale = await realList(...a); // validation sees the live recipient …
      const { deleteRecipientWithSchedules } = await import('@/lib/portal-recipients');
      expect((await deleteRecipientWithSchedules(db, 'pa', PHONE, recipientRid('pa', PHONE, A_RP))).ok).toBe(true); // … then the delete commits
      return stale;
    });
    const parsed = good(recipientRid('pa', PHONE, A_RP));
    if (!parsed.ok) throw new Error('form');
    expect(await createPortalSchedule(db, ctx, 'pa', PHONE, parsed.value)).toEqual({ ok: false, code: 'not_found' });
    const live = (await createScheduleRepo(db).listForCustomer('pa', PHONE)).filter((s) => s.status !== 'cancelled');
    expect(live).toEqual([]);
    expect((await audits()).map((a) => a.action)).toEqual(['schedule.cancel']); // the delete's own sweep only
  });
  // The other order (the create commits first, the delete then waits on the address-book lock and its
  // schedule sweep sees and cancels the new schedule) needs two connections; PGlite has one, so it is
  // argued in lockRecipientBook's comment, not tested here.
});

describe('create racing a recipient edit (delta review LOW-B)', () => {
  it('an account change that lands after validation: refused (recipient_changed), nothing written', async () => {
    const ctx = ctxFor('pa');
    const realList = ctx.store.listRecipients.bind(ctx.store);
    vi.spyOn(ctx.store, 'listRecipients').mockImplementation(async (...a: Parameters<typeof ctx.store.listRecipients>) => {
      const stale = await realList(...a);
      await createRecipientRepo(db).updateLiveRecipient('pa', PHONE, {
        name: 'Recipient PA', recipientPhone: A_RP, payoutMethod: 'bank', payoutDestination: '999988887777|ICIC0004321', lastUsedAt: new Date().toISOString(),
      });
      return stale;
    });
    const parsed = good(recipientRid('pa', PHONE, A_RP));
    if (!parsed.ok) throw new Error('form');
    const before = await count();
    expect(await createPortalSchedule(db, ctx, 'pa', PHONE, parsed.value)).toEqual({ ok: false, code: 'recipient_changed' });
    expect(await count()).toBe(before);
    expect(await audits()).toEqual([]);
  });
});

describe('setPortalScheduleStatus', () => {
  const id = () => A.scheduleIds[0];

  it('pause → resume → cancel, each audited with the states; a cancelled schedule cannot resume', async () => {
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'pause')).toEqual({ ok: true, status: 'paused' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'pause')).toEqual({ ok: false, code: 'already_paused' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'resume')).toEqual({ ok: true, status: 'active' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'resume')).toEqual({ ok: false, code: 'not_paused' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'cancel')).toEqual({ ok: true, status: 'cancelled' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'resume')).toEqual({ ok: false, code: 'cancelled' });
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'cancel')).toEqual({ ok: false, code: 'cancelled' });
    expect((await audits()).map((a) => [a.action, a.meta])).toEqual([
      ['schedule.pause', { scheduleId: id(), from: 'active', to: 'paused' }],
      ['schedule.resume', { scheduleId: id(), from: 'paused', to: 'active' }],
      ['schedule.cancel', { scheduleId: id(), from: 'active', to: 'cancelled' }],
    ]);
  });

  it("isolation: A cannot pause, resume or cancel B's schedule or another customer's; one not_found, nothing written", async () => {
    await seedSender(db, { partnerId: 'pa', phone: OTHER, firstSeenDaysAgo: 5, kycStatus: 'verified' });
    const other: Schedule = { ...(await createScheduleRepo(db).getOwnedSchedule('pa', PHONE, id()))!, id: 's_other_1', phone: OTHER };
    await createScheduleRepo(db).saveSchedule(other);
    for (const target of [B.scheduleIds[0], 's_other_1', 'missing_id', '../x', '']) {
      for (const op of ['pause', 'resume', 'cancel'] as const) {
        expect(await setPortalScheduleStatus(db, 'pa', PHONE, target, op)).toEqual({ ok: false, code: 'not_found' });
      }
    }
    expect((await createScheduleRepo(db).getOwnedSchedule('pb', PHONE, B.scheduleIds[0]))?.status).toBe('active');
    expect((await createScheduleRepo(db).getOwnedSchedule('pa', OTHER, 's_other_1'))?.status).toBe('active');
    expect(await audits()).toEqual([]);
  });

  it('a cancel decided on a stale read writes nothing when the status moved (the audit `from` is always true)', async () => {
    const realTx = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((async (fn: Parameters<typeof db.transaction>[0]) => {
      await createScheduleRepo(db).setStatusIf(id(), 'pa', ['active'], 'paused'); // a pause commits after the action's read
      return realTx(fn);
    }) as typeof db.transaction);
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'cancel')).toEqual({ ok: false, code: 'changed' });
    spy.mockRestore();
    expect((await createScheduleRepo(db).getOwnedSchedule('pa', PHONE, id()))?.status).toBe('paused');
    expect(await audits()).toEqual([]);
  });

  it('a concurrent pause + cancel (both decided on the same active read): exactly one wins', async () => {
    const r = await Promise.all([
      setPortalScheduleStatus(db, 'pa', PHONE, id(), 'pause'),
      setPortalScheduleStatus(db, 'pa', PHONE, id(), 'cancel'),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok)).toEqual([{ ok: false, code: 'changed' }]);
    expect(await audits()).toHaveLength(1);
  });

  it('two concurrent pauses: exactly one wins, the loser writes nothing (conditional write)', async () => {
    const r = await Promise.all([
      setPortalScheduleStatus(db, 'pa', PHONE, id(), 'pause'),
      setPortalScheduleStatus(db, 'pa', PHONE, id(), 'pause'),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect((await audits()).filter((a) => a.action === 'schedule.pause')).toHaveLength(1);
  });

  it('a pause decided on a stale read cannot resurrect a cancelled schedule', async () => {
    const repo = createScheduleRepo(db);
    const stale = (await repo.getOwnedSchedule('pa', PHONE, id()))!;
    expect(await setPortalScheduleStatus(db, 'pa', PHONE, id(), 'cancel')).toEqual({ ok: true, status: 'cancelled' });
    // Replay the pause's write with the decision made on the stale 'active' read.
    expect(await repo.setStatusIf(stale.id, 'pa', ['active'], 'paused')).toBeNull();
    expect((await repo.getOwnedSchedule('pa', PHONE, id()))?.status).toBe('cancelled');
  });
});

describe('list and display helpers', () => {
  it('visibleSchedules keeps active and paused (newest first as given), drops cancelled', () => {
    const s = (id: string, status: Schedule['status']) => ({ id, status }) as Schedule;
    expect(visibleSchedules([s('a', 'active'), s('b', 'cancelled'), s('c', 'paused')]).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('isScheduleId accepts the opaque id charset only', () => {
    expect(isScheduleId(A.scheduleIds[0])).toBe(true);
    for (const v of ['', '../x', 'a b', 'x'.repeat(81), 5, null]) expect(isScheduleId(v)).toBe(false);
  });

  it('describeSchedule names the cadence without a phone or an account', () => {
    expect(describeSchedule({ frequency: 'monthly', dayOfMonth: 5 } as Schedule)).toEqual({ key: 'portal.schedules.monthlyOn', vars: { day: 5 } });
    expect(describeSchedule({ frequency: 'weekly', dayOfWeek: 1 } as Schedule)).toEqual({ key: 'portal.schedules.weeklyOn', vars: { weekday: 'Monday' } });
  });

  it('recordScheduleAudit refuses any meta outside the allow-list (never a value)', async () => {
    await expect(
      recordScheduleAudit(db, { partnerId: 'pa', phone: PHONE, action: 'schedule.create', meta: { scheduleId: 's_1', phone: PHONE } as never }),
    ).rejects.toThrow('not allowed');
    expect(await audits()).toEqual([]);
  });
});
