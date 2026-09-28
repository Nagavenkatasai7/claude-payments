import type { Db } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { last4 } from '@/db/repos/mappers';
import { newTransferId } from '@/lib/id';
import type { PartnerId, Schedule } from '@/lib/types';
import { seedLedgerSpend, seedPartner, seedSender } from './helpers-db';

// helpers-portal-two-partner — the SHARED isolation fixture for every M2 (customer
// portal) test (UI redesign M2-2, Task 2.3). Two active partners, 'pa' and 'pb',
// and ONE phone that is a customer of BOTH (`customers` PK = (partner_id, phone)).
// Per partner: 2 transfers (one paid, one delivered), 1 saved recipient (distinct
// masked last4 per partner), 1 active schedule and 1 open customer ticket.
// Written through the repos (sealed columns, NOT NULLs) and the existing seed helpers.

export const TWO_PARTNER_PHONE = '14155550101';

export interface TwoPartnerFixture {
  partnerId: PartnerId;
  transferIds: string[];
  recipientPhones: string[];
  /** Masked last 4 digits of the saved recipient's payout account. */
  recipientLast4: string;
  scheduleIds: string[];
  ticketIds: string[];
}

const PER_PARTNER = {
  pa: { name: 'Partner A', destination: '000011112222|HDFC0001111', recipientPhone: '919000000001' },
  pb: { name: 'Partner B', destination: '000033334444|ICIC0002222', recipientPhone: '919000000002' },
} as const;

async function seedOne(db: Db, partnerId: 'pa' | 'pb', phone: string): Promise<TwoPartnerFixture> {
  const p = PER_PARTNER[partnerId];
  await seedPartner(db, partnerId, p.name);
  await seedSender(db, { partnerId, phone, firstSeenDaysAgo: 10, kycStatus: 'verified' });

  const paid = await seedLedgerSpend(db, { partnerId, phone, amountUsd: 100, status: 'paid' });
  const delivered = await seedLedgerSpend(db, {
    partnerId,
    phone,
    amountUsd: 50,
    status: 'delivered',
    createdAt: new Date(Date.now() - 2 * 86_400_000),
  });

  const destination = p.destination;
  await createRecipientRepo(db).upsertRecipient(partnerId, phone, {
    name: `Recipient ${partnerId.toUpperCase()}`,
    recipientPhone: p.recipientPhone,
    payoutMethod: 'bank',
    payoutDestination: destination,
    lastUsedAt: new Date().toISOString(),
  });

  const scheduleId = `s_${newTransferId()}`;
  const schedule: Schedule = {
    id: scheduleId,
    phone,
    amountUsd: 25,
    recipientName: `Recipient ${partnerId.toUpperCase()}`,
    recipientPhone: p.recipientPhone,
    payoutMethod: 'bank',
    payoutDestination: destination,
    fundingMethod: 'bank_transfer',
    frequency: 'monthly',
    dayOfMonth: 1,
    status: 'active',
    createdAt: new Date().toISOString(),
    partnerId,
    sourceCurrency: 'USD',
    amountSource: 25,
  };
  await createScheduleRepo(db).saveSchedule(schedule);

  const ticketId = `tk_${newTransferId()}`;
  await createTicketRepo(db).createTicket({
    id: ticketId,
    partnerId,
    kind: 'customer',
    customerPhone: phone,
    subject: 'Fixture question',
    body: 'Fixture ticket body',
  });

  return {
    partnerId,
    transferIds: [paid, delivered],
    recipientPhones: [p.recipientPhone],
    recipientLast4: last4(destination), // the repo's own masking
    scheduleIds: [scheduleId],
    ticketIds: [ticketId],
  };
}

/** Seed partners A ('pa') and B ('pb') sharing ONE customer phone. Call after freshDb(). */
export async function seedTwoPartners(
  db: Db,
): Promise<{ A: TwoPartnerFixture; B: TwoPartnerFixture; phone: string }> {
  const phone = TWO_PARTNER_PHONE;
  const A = await seedOne(db, 'pa', phone);
  const B = await seedOne(db, 'pb', phone);
  return { A, B, phone };
}
