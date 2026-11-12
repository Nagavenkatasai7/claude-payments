// Fix pack 8 T3 (R44, P5): the server reader of the two facts the pure routing cannot read.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { errorNoticeFacts } from '@/lib/error-notice-facts';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import * as log from '@/lib/log';
import type { Db } from '@/db/client';
import type { DisclosureSnapshotV1 } from '@/lib/remittance-disclosure';

const snapshot = (days: number): DisclosureSnapshotV1 => ({
  v: 1,
  version: 'draft-test',
  configHash: 'cfg-hash',
  shownHash: null,
  figures: {
    amountSource: 100, feeSource: 2, totalChargeSource: 102, sourceCurrency: 'USD',
    amountDest: 8500, destinationCurrency: 'INR', fxRate: 85,
  },
  provider: {
    kind: 'configured', licensedEntity: 'Acme Money Services LLC', licenceIds: ['NMLS 000000'],
    phone: null, website: null, regulator: 'State Dept', approved: true,
  },
  deliveryBusinessDays: days,
  dateAvailable: `within ${days} business days`,
  acknowledgedAt: new Date(Date.now() - 60_000).toISOString(),
  surface: 'transfer',
});

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('errorNoticeFacts (P5)', () => {
  it('18. reads no snapshot when the row has its own days', async () => {
    await seedPartnerTransfer(db, { id: 'tr_own', partnerId: 'pa', deliveryBusinessDays: 2 });
    const stop = captureQueries();
    const f = await errorNoticeFacts(db, { id: 'tr_own', partnerId: 'pa', deliveryBusinessDays: 2 });
    const qs = stop();
    expect(f.snapshotDays).toBeNull();
    expect(qs.some((q) => q.sql.includes('disclosure_snapshot'))).toBe(false);
    // a row with 0 days is its own value too
    const stop2 = captureQueries();
    await errorNoticeFacts(db, { id: 'tr_own', partnerId: 'pa', deliveryBusinessDays: 0 });
    expect(stop2().some((q) => q.sql.includes('disclosure_snapshot'))).toBe(false);
  });

  it("19. reads the snapshot days when the row has none, never another tenant's", async () => {
    await seedPartnerTransfer(db, { id: 'tr_snap', partnerId: 'pa', status: 'awaiting_payment' });
    expect(await createTransferRepo(db).setDisclosureSnapshotIfAwaiting('tr_snap', 'pa', snapshot(4))).toBe(true);
    const stop = captureQueries();
    const f = await errorNoticeFacts(db, { id: 'tr_snap', partnerId: 'pa', deliveryBusinessDays: undefined });
    expect(stop().some((q) => q.sql.includes('disclosure_snapshot'))).toBe(true);
    expect(f.snapshotDays).toBe(4);
    const other = await errorNoticeFacts(db, { id: 'tr_snap', partnerId: 'pb', deliveryBusinessDays: undefined });
    expect(other.snapshotDays).toBeNull();
    // no snapshot stored -> null
    await seedPartnerTransfer(db, { id: 'tr_none', partnerId: 'pa' });
    expect((await errorNoticeFacts(db, { id: 'tr_none', partnerId: 'pa', deliveryBusinessDays: undefined })).snapshotDays).toBeNull();
  });

  it('20. chargedAt from the stage1 outbox row; none -> null', async () => {
    await seedPartnerTransfer(db, { id: 'tr_ch', partnerId: 'pa', deliveryBusinessDays: 1 });
    expect((await errorNoticeFacts(db, { id: 'tr_ch', partnerId: 'pa', deliveryBusinessDays: 1 })).chargedAt).toBeNull();
    await createOutboxRepo(db).enqueue('whatsapp.text', { to: 'x', text: 'y' }, { dedupeKey: 'stage1:tr_ch' });
    await db.execute(sql`UPDATE outbox SET created_at = now() - make_interval(mins => 12) WHERE dedupe_key = 'stage1:tr_ch'`);
    const now = Date.now();
    const f = await errorNoticeFacts(db, { id: 'tr_ch', partnerId: 'pa', deliveryBusinessDays: 1 }, now);
    expect(f.chargedAt).not.toBeNull();
    expect(Math.abs(f.chargedAt! - (now - 12 * 60_000))).toBeLessThan(5_000);
  });

  it('21. a failing read yields null and logs the error name only', async () => {
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    class SecretBearingError extends Error {
      constructor() {
        super('connection to postgres://user:pw@host failed for +14155550101');
        this.name = 'SecretBearingError';
      }
    }
    const boom = () => {
      throw new SecretBearingError();
    };
    const broken = { select: boom, execute: boom } as unknown as Db;
    const f = await errorNoticeFacts(broken, { id: 'tr_x', partnerId: 'pa', deliveryBusinessDays: undefined });
    expect(f).toEqual({ snapshotDays: null, chargedAt: null });
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call[0]).toBe('error-notice.facts');
      expect(call[1]).toBe('SecretBearingError');
      expect(call[2]).toEqual({ transferId: 'tr_x' });
      expect(JSON.stringify(call)).not.toContain('postgres://');
      expect(JSON.stringify(call)).not.toContain('14155550101');
    }
    warn.mockRestore();
  });
});
