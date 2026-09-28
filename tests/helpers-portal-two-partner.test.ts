import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { seedTwoPartners, TWO_PARTNER_PHONE } from './helpers-portal-two-partner';
import { createPortalSessionStore } from '@/lib/portal-session-store';

// M2-2 Task 2.3: self-test of the shared two-partner isolation fixture. Every M2
// isolation test seeds it: ONE phone that is a customer of BOTH partners, with
// per-partner transfers, a saved recipient, a schedule and a ticket.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe('seedTwoPartners', () => {
  it('creates two active partners and one phone that is a customer of both (customers PK = partner, phone)', async () => {
    const { A, B, phone } = await seedTwoPartners(db);
    expect(phone).toBe(TWO_PARTNER_PHONE);
    expect(phone).toMatch(/^\d+$/); // digits only, the customers PK format
    expect([A.partnerId, B.partnerId]).toEqual(['pa', 'pb']);
    const partners = await db.select().from(schema.partners).where(eq(schema.partners.status, 'active'));
    expect(partners.map((p) => p.id)).toEqual(expect.arrayContaining(['pa', 'pb']));
    const rows = await db.select().from(schema.customers).where(eq(schema.customers.phone, phone));
    expect(rows.map((r) => r.partnerId).sort()).toEqual(['pa', 'pb']);
  });

  it('per partner: 2 transfers (paid + delivered), 1 recipient, 1 active schedule, 1 open ticket', async () => {
    const { A, B, phone } = await seedTwoPartners(db);
    for (const f of [A, B]) {
      const tx = await db.select().from(schema.transfers)
        .where(and(eq(schema.transfers.partnerId, f.partnerId), eq(schema.transfers.phone, phone)));
      expect(tx.map((t) => t.id).sort()).toEqual([...f.transferIds].sort());
      expect(tx.map((t) => t.status).sort()).toEqual(['delivered', 'paid']);

      const rc = await db.select().from(schema.recipients)
        .where(and(eq(schema.recipients.partnerId, f.partnerId), eq(schema.recipients.senderPhone, phone)));
      expect(rc.map((r) => r.recipientPhone)).toEqual(f.recipientPhones);
      expect(rc[0].payoutDestinationLast4).toBe(f.recipientLast4);

      const sc = await db.select().from(schema.schedules).where(eq(schema.schedules.partnerId, f.partnerId));
      expect(sc.map((s) => s.id)).toEqual(f.scheduleIds);
      expect(sc[0].status).toBe('active');
      expect(sc[0].phone).toBe(phone);

      const tk = await db.select().from(schema.tickets).where(eq(schema.tickets.partnerId, f.partnerId));
      expect(tk.map((t) => t.id)).toEqual(f.ticketIds);
      expect(tk[0].status).toBe('open');
      expect(tk[0].customerPhone).toBe(phone);
    }
  });

  it('the two partners share no row id and show distinct masked recipient digits', async () => {
    const { A, B } = await seedTwoPartners(db);
    for (const k of ['transferIds', 'scheduleIds', 'ticketIds'] as const) {
      expect(A[k].filter((id) => B[k].includes(id))).toEqual([]);
    }
    expect(A.recipientLast4).not.toBe(B.recipientLast4);
  });

  it('is the session isolation fixture: A’s cookie is refused on B’s host; one phone = two independent sessions', async () => {
    const { A, B, phone } = await seedTwoPartners(db);
    const s = createPortalSessionStore(fakeRedis());
    const a = await s.create(A.partnerId, phone, 'Chrome on macOS');
    const b = await s.create(B.partnerId, phone, 'Safari on iPhone');
    expect(await s.resolve(a.token, B.partnerId)).toBeNull();
    expect(await s.resolve(b.token, A.partnerId)).toBeNull();
    expect(await s.revokeAll(A.partnerId, phone)).toBe(1);
    expect(await s.resolve(a.token, A.partnerId)).toBeNull();
    expect((await s.resolve(b.token, B.partnerId))?.partnerId).toBe(B.partnerId);
  });
});
