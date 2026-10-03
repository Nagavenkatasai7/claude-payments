import { describe, it, expect, beforeEach } from 'vitest';
import { executeTool } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// 2026-10-03 "bot chats mixing" thread: two testers on one bot, and both have a
// "Mom". Everything the bot keeps about a customer is keyed by (workspace,
// phone); nothing is ever matched across customers by recipient name. This
// suite pins that for every chat tool that reads per-customer data, and for the
// 30-day chat history, so no later change can merge two customers' context.

const A = '15551110001';
const B = '15551110002';
let db: Db;
let redis: ReturnType<typeof fakeRedis>;

async function ctxFor(phone: string, partnerId = 'default') {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const now = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
    partnerId, optInAt: now, fullName: phone === A ? 'Asha Customer' : 'Bina Customer', createdAt: now, updatedAt: now,
  });
  return {
    phone,
    partnerId,
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

const MOM_A = { name: 'Mom', recipientPhone: '919100000001', payoutMethod: 'upi' as const, payoutDestination: 'mom-a@upi', lastUsedAt: new Date().toISOString() };
const MOM_B = { name: 'Mom', recipientPhone: '919100000002', payoutMethod: 'upi' as const, payoutDestination: 'mom-b@upi', lastUsedAt: new Date().toISOString() };

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
});

describe('two customers on one bot, both with a "Mom"', () => {
  it('resolve_recipient("Mom") returns each customer only their own Mom', async () => {
    const a = await ctxFor(A);
    const b = await ctxFor(B);
    await a.store.upsertRecipient('default', A, MOM_A);
    await b.store.upsertRecipient('default', B, MOM_B);

    const ra = await executeTool('resolve_recipient', { name: 'Mom' }, a);
    const rb = await executeTool('resolve_recipient', { name: 'Mom' }, b);
    expect(ra).toMatchObject({ match: 'exact', recipient: { recipient_phone: MOM_A.recipientPhone } });
    expect(rb).toMatchObject({ match: 'exact', recipient: { recipient_phone: MOM_B.recipientPhone } });
  });

  it('a customer with no saved Mom gets no match, even though another customer has one', async () => {
    const a = await ctxFor(A);
    const b = await ctxFor(B);
    await a.store.upsertRecipient('default', A, MOM_A);
    expect(await executeTool('resolve_recipient', { name: 'Mom' }, b)).toEqual({ match: 'none' });
    expect(await executeTool('list_saved_recipients', {}, b)).toEqual({ recipients: [] });
  });

  it("list_schedules shows only the customer's own schedules, and the other's id can't be cancelled", async () => {
    const a = await ctxFor(A);
    const b = await ctxFor(B);
    const args = {
      amount_usd: 500, recipient_name: 'Mom', payout_method: 'upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 3,
    };
    const sa = await executeTool('create_schedule', { ...args, recipient_phone: MOM_A.recipientPhone, payout_destination: MOM_A.payoutDestination }, a);
    const sb = await executeTool('create_schedule', { ...args, recipient_phone: MOM_B.recipientPhone, payout_destination: MOM_B.payoutDestination }, b);

    const la = (await executeTool('list_schedules', {}, a)).schedules as Array<{ schedule_id: string }>;
    const lb = (await executeTool('list_schedules', {}, b)).schedules as Array<{ schedule_id: string }>;
    expect(la.map((s) => s.schedule_id)).toEqual([sa.schedule_id]);
    expect(lb.map((s) => s.schedule_id)).toEqual([sb.schedule_id]);

    expect(await executeTool('cancel_schedule', { schedule_id: sa.schedule_id }, b)).toEqual({ error: 'Schedule not found.' });
    expect((await a.scheduleStore.getSchedule(sa.schedule_id as string))?.status).toBe('active');
  });

  it("check_payment_status never answers for another customer's transfer", async () => {
    const a = await ctxFor(A);
    const b = await ctxFor(B);
    const ta = await seedLedgerSpend(db, { partnerId: 'default', phone: A, amountUsd: 500 });
    expect(await executeTool('check_payment_status', { transfer_id: ta }, a)).toMatchObject({ transfer_id: ta });
    expect(await executeTool('check_payment_status', { transfer_id: ta }, b)).toEqual({ error: 'Transfer not found.' });
  });

  it('chat history is kept per customer', async () => {
    const a = await ctxFor(A);
    await a.store.saveConversation('default', A, [{ role: 'user', content: 'send 500 to Mom' }]);
    expect(await a.store.getConversation('default', B)).toEqual([]);
    expect(await a.store.getConversation('default', A)).toHaveLength(1);
  });
});

describe('one phone in two workspaces', () => {
  it("never sees the other workspace's recipients, schedules or chat history", async () => {
    await seedPartner(db, 'acme');
    const home = await ctxFor(A, 'default');
    const acme = await ctxFor(A, 'acme');
    await home.store.upsertRecipient('default', A, MOM_A);
    await home.store.saveConversation('default', A, [{ role: 'user', content: 'hi' }]);
    await executeTool('create_schedule', {
      amount_usd: 500, recipient_name: 'Mom', recipient_phone: MOM_A.recipientPhone, payout_method: 'upi',
      payout_destination: MOM_A.payoutDestination, funding_method: 'bank_transfer', frequency: 'monthly', day_of_month: 3,
    }, home);

    expect(await executeTool('resolve_recipient', { name: 'Mom' }, acme)).toEqual({ match: 'none' });
    expect((await executeTool('list_schedules', {}, acme)).schedules).toEqual([]);
    expect(await acme.store.getConversation('acme', A)).toEqual([]);
  });
});
