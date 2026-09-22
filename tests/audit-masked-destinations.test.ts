import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { findMaskedDestinationRows } from '../scripts/audit-masked-destinations';
import type { Db } from '@/db/client';
import type { Schedule, Transfer } from '@/lib/types';

const SENDER = '15551234567';
const DAY = 86_400_000;

const t = (id: string, dest: string, over: Partial<Transfer> = {}): Transfer => ({
  id, phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17000,
  recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: dest,
  fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
  createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
  destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0, totalChargeSource: 200,
  ...over,
});

const s = (id: string, dest: string, over: Partial<Schedule> = {}): Schedule => ({
  id, phone: SENDER, amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
  payoutMethod: 'bank', payoutDestination: dest, fundingMethod: 'bank_transfer', frequency: 'monthly',
  dayOfMonth: 5, status: 'active', createdAt: new Date(Date.now() - 2 * DAY).toISOString(), partnerId: 'default',
  sourceCurrency: 'USD', amountSource: 100, ...over,
});

describe('scripts/audit-masked-destinations — findMaskedDestinationRows (fix 6 / ctx-01)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('reports every ctx-01 footprint and prints no destination and no full phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(t('poisoned', '****9012'));
    await store.saveTransfer(t('poisoned_paid', 'account on file', { status: 'paid' }));
    await store.saveTransfer(t('real', 'HDFC0001234 123456789012'));
    await store.saveTransfer(t('empty', ''));
    await store.saveTransfer(t('pulled_consumer', 'HDFC0001234 123456789012', { fundingMethod: 'bank_pull' }));
    await store.saveTransfer(t('b2b_ach', '', { fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await store.upsertRecipient('default', SENDER, {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '****9012',
      lastUsedAt: new Date().toISOString(),
    });
    await store.upsertRecipient('default', SENDER, {
      name: 'Dad', recipientPhone: '919811111111', payoutMethod: 'bank', payoutDestination: 'SBIN0001234 987654321',
      lastUsedAt: new Date().toISOString(),
    });
    const schedules = createScheduleStore(db);
    await schedules.saveSchedule(s('sch_masked', '****9012'));
    await schedules.saveSchedule(s('sch_invented', 'xxxx9012'));
    await schedules.saveSchedule(s('sch_empty', ''));
    await schedules.saveSchedule(s('sch_post', 'HDFC0001234 123456789012', { createdAt: new Date().toISOString() }));
    await schedules.saveSchedule(s('sch_pulled', '', { fundingMethod: 'ach_pull' }));

    const report = await findMaskedDestinationRows(db, { before: new Date(Date.now() - DAY) });

    expect(report.transfers.map((r) => r.id).sort()).toEqual(['poisoned', 'poisoned_paid']);
    expect(report.recipients).toHaveLength(1);
    expect(report.recipients[0]).toMatchObject({ partner_id: 'default', sender_last4: '4567', recipient_last4: '3210' });
    expect(report.schedules.map((r) => r.id)).toEqual(['sch_masked']);
    expect(report.pulledConsumerTransfers.map((r) => r.id)).toEqual(['pulled_consumer']);
    expect(report.nonConsumerFundingSchedules.map((r) => r.id)).toEqual(['sch_pulled']);
    expect(report.preFixScheduleDestinations.map((r) => r.id).sort()).toEqual(['sch_invented', 'sch_masked']);
    const printed = JSON.stringify(report);
    for (const secret of ['123456789012', '987654321', '9012', SENDER, '919876543210']) {
      expect(printed).not.toContain(secret);
    }
  });
});
