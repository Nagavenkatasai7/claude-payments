import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { readPurposeDetailsForStaff } from '@/lib/purpose-detail-staff';
import { auditSubjectId } from '@/lib/customer-ref';
import type { Transfer } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';

// Batch B follow-up A4: staff reads of the customer's "Other" reason (admin transaction page,
// compliance queue, partner transfer page). Decrypted, pinned to the staff member's tenant, one
// pii.view row per transfer shown (field names only), with the staff-only scam-pattern label.

let db: Db;
const PHONE = '15551230000';

const fixture = (over: Partial<Transfer>): Transfer => ({
  id: 'tr_x', phone: PHONE, amountUsd: 100, feeUsd: 2, totalChargeUsd: 102, fxRate: 85, amountInr: 8500,
  recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '000011112222|HDFC0001111',
  fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
  createdAt: new Date().toISOString(), partnerId: 'default', sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
  destinationCurrency: 'INR', amountSource: 100, feeSource: 2, totalChargeSource: 102, ...over,
});

const piiViews = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'pii.view'));

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

async function seed() {
  const repo = createTransferRepo(db);
  const rows = [
    fixture({ id: 'tr_scam', purpose: 'other', purposeDetail: 'to claim my lottery prize' }),
    fixture({ id: 'tr_plain', purpose: 'other', purposeDetail: 'helping a neighbour repair the roof' }),
    fixture({ id: 'tr_none', purpose: 'gift' }),
    fixture({ id: 'tr_acme', partnerId: 'acme', purpose: 'other', purposeDetail: 'customs charge for a parcel' }),
  ];
  for (const t of rows) await repo.saveTransfer(t);
  return rows;
}

describe('readPurposeDetailsForStaff', () => {
  it('platform staff: the reasons of the transfers shown, with the risk label; one pii.view per reason', async () => {
    const rows = await seed();
    const out = await readPurposeDetailsForStaff(db, { username: 'ops1' }, rows, { tenant: null });
    expect(out.get('tr_scam')).toEqual({ detail: 'to claim my lottery prize', riskLabel: 'Prize or lottery' });
    expect(out.get('tr_plain')).toEqual({ detail: 'helping a neighbour repair the roof', riskLabel: null });
    expect(out.get('tr_acme')).toEqual({ detail: 'customs charge for a parcel', riskLabel: 'Parcel or customs' });
    expect(out.has('tr_none')).toBe(false);
    const audits = await piiViews();
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a).toMatchObject({ actor: 'ops1', actorType: 'staff' });
      expect((a.meta as { fields: string[] }).fields).toEqual(['purpose_detail']);
      expect(JSON.stringify(a)).not.toMatch(/lottery|neighbour|parcel/);
    }
    const scam = audits.find((a) => (a.meta as { transferId: string }).transferId === 'tr_scam')!;
    expect(scam).toMatchObject({ partnerId: 'default', subjectId: auditSubjectId('default', PHONE) });
  });

  it('tenant-pinned staff never read another tenant\'s reason, even when the caller passes its row', async () => {
    const rows = await seed();
    const out = await readPurposeDetailsForStaff(db, { username: 'acme-admin' }, rows, { tenant: 'acme', actorScope: 'partner' });
    expect([...out.keys()]).toEqual(['tr_acme']);
    const audits = await piiViews();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ partnerId: 'acme', meta: { fields: ['purpose_detail'], transferId: 'tr_acme', actorScope: 'partner' } });
  });

  it('writes the pii.view rows in ONE batch insert (security review L5)', async () => {
    const rows = await seed();
    const insert = vi.spyOn(db, 'insert');
    await readPurposeDetailsForStaff(db, { username: 'ops1' }, rows, { tenant: null });
    expect(insert.mock.calls.filter(([table]) => table === auditEvents)).toHaveLength(1);
    expect(await piiViews()).toHaveLength(3);
    insert.mockRestore();
  });

  it('a failed audit write fails the read (awaited, not caught)', async () => {
    const rows = await seed();
    const insert = vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('audit down');
    });
    await expect(readPurposeDetailsForStaff(db, { username: 'ops1' }, rows, { tenant: null })).rejects.toThrow('audit down');
    insert.mockRestore();
  });

  it('a transfer shown twice (in review AND flagged) is read and audited once; nothing shown ⇒ no query, no audit', async () => {
    const rows = await seed();
    await readPurposeDetailsForStaff(db, { username: 'ops1' }, [rows[0], rows[0]], { tenant: null });
    expect(await piiViews()).toHaveLength(1);
    expect((await readPurposeDetailsForStaff(db, { username: 'ops1' }, [], { tenant: null })).size).toBe(0);
    expect(await piiViews()).toHaveLength(1);
  });
});
