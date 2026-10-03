import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool } from '@/lib/tools';
import { botScheduleAuditEvent, BOT_SCHEDULE_ACTOR } from '@/lib/bot-schedule-audit';
import { auditSubjectId } from '@/lib/customer-ref';
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
import { freshDb } from './helpers-db';

// 2026-10-03 "bot chats mixing" thread: a schedule made in chat left no record
// of who made it or when, so "whose schedule is this?" could not be answered
// from the audit log. These pin the bot's schedule.create / schedule.cancel rows.

const PHONE = '15551230001';
let db: Db;

async function ctxFor(phone: string, channel?: 'whatsapp' | 'web') {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const now = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
    partnerId: 'default', optInAt: now, fullName: 'Alex Rivera', createdAt: now, updatedAt: now,
  });
  return {
    phone,
    partnerId: 'default',
    ...(channel ? { channel } : {}),
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

const SCHEDULE_ARGS = {
  amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
  payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
  frequency: 'monthly', day_of_month: 2,
};

async function auditRows(action: string) {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = ${action} ORDER BY id`);
  return (r as unknown as { rows: Array<Record<string, unknown>> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
});

describe('botScheduleAuditEvent (pure)', () => {
  it('keys the subject by the keyed customer id, never the raw phone', () => {
    const e = botScheduleAuditEvent({ partnerId: 'default', phone: PHONE, action: 'schedule.create', scheduleId: 'abc123', channel: 'whatsapp' });
    expect(e.subjectId).toBe(auditSubjectId('default', PHONE));
    expect(JSON.stringify(e)).not.toContain(PHONE);
    expect(e).toMatchObject({ partnerId: 'default', actor: BOT_SCHEDULE_ACTOR, actorType: 'system', action: 'schedule.create', meta: { scheduleId: 'abc123', via: 'whatsapp' } });
  });

  it('records the web chat as via web', () => {
    const e = botScheduleAuditEvent({ partnerId: 'default', phone: PHONE, action: 'schedule.cancel', scheduleId: 'abc123', channel: 'web' });
    expect(e.meta).toEqual({ scheduleId: 'abc123', via: 'web' });
  });
});

describe('bot schedule tools write an audit row', () => {
  it('create_schedule writes schedule.create for the owning customer', async () => {
    const c = await ctxFor(PHONE);
    const r = await executeTool('create_schedule', SCHEDULE_ARGS, c);
    expect(r.schedule_id).toBeTruthy();
    const rows = await auditRows('schedule.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'default', actor: BOT_SCHEDULE_ACTOR, actor_type: 'system',
      subject_id: auditSubjectId('default', PHONE),
      meta: { scheduleId: r.schedule_id, via: 'whatsapp' },
    });
  });

  it('cancel_schedule writes schedule.cancel; a refused cancel writes nothing', async () => {
    const owner = await ctxFor(PHONE);
    const created = await executeTool('create_schedule', SCHEDULE_ARGS, owner);
    const other = await ctxFor('15551230002');
    const refused = await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, other);
    expect(refused.error).toBe('Schedule not found.');
    expect(await auditRows('schedule.cancel')).toHaveLength(0);

    await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, owner);
    const rows = await auditRows('schedule.cancel');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_id: auditSubjectId('default', PHONE), meta: { scheduleId: created.schedule_id, via: 'whatsapp' } });
  });

  it('a failing audit write never fails the customer: the schedule is still created and cancelled', async () => {
    const c = await ctxFor(PHONE);
    c.store.recordAudit = async () => { throw new Error('audit down'); };
    const created = await executeTool('create_schedule', SCHEDULE_ARGS, c);
    expect(created.schedule_id).toBeTruthy();
    expect((await c.scheduleStore.getSchedule(created.schedule_id as string))?.status).toBe('active');
    const cancelled = await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, c);
    expect(cancelled.error).toBeUndefined();
    expect((await c.scheduleStore.getSchedule(created.schedule_id as string))?.status).toBe('cancelled');
  });
});
