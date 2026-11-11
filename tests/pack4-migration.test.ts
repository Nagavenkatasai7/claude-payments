import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { findDestructive } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 4 T1 (migration 0038, contracts C1/C2): two nullable `transfers`
// columns (disclosure_snapshot, delivery_business_days) and one nullable
// `recipients` column (legal_name_enc). ADDITIVE ONLY: the old build names none
// of them (explicit column lists), so it keeps working while the build applies it.

let seq = 0;
const makeTransfer = (o: Partial<Transfer> = {}): Transfer => ({
  id: `t_pack4_${++seq}`, phone: '15550000001', amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85,
  amountInr: 8500, recipientName: 'R', recipientPhone: '919000000000', payoutMethod: 'bank',
  payoutDestination: '000011112222|HDFC0000001', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
  complianceReasons: [], status: 'awaiting_payment', createdAt: new Date().toISOString(), sourceCountry: 'US',
  sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
  amountSource: 100, feeSource: 0, totalChargeSource: 100, ...o,
});

const FILE = join(process.cwd(), 'drizzle/0038_pay_step_evidence.sql');
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;

describe('drizzle/0038_pay_step_evidence.sql', () => {
  const body = readFileSync(FILE, 'utf8');
  const statements = body
    .split('\n')
    .filter((l) => !l.startsWith('--') && l.trim() !== '')
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  it('0038 is additive: lock_timeout, then three nullable ADD COLUMNs with no DEFAULT or constraint', () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(statements.slice(1)).toEqual([
      'ALTER TABLE "transfers" ADD COLUMN "disclosure_snapshot" jsonb;',
      'ALTER TABLE "transfers" ADD COLUMN "delivery_business_days" smallint;',
      'ALTER TABLE "recipients" ADD COLUMN "legal_name_enc" text;',
    ]);
  });

  it('passes the CI migration guard (no destructive statement)', () => {
    expect(findDestructive(body)).toEqual([]);
  });

  it('the journal carries it at idx 38, after 0037', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0038_pay_step_evidence');
    const prev = journal.entries.find((e) => e.tag === '0037_live_controls');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(38);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });
});

describe('0038 columns (applied)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('freshDb applies it: the three columns exist, nullable, with the agreed types', async () => {
    const cols = await rows<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE (table_name = 'transfers' AND column_name IN ('disclosure_snapshot', 'delivery_business_days'))
          OR (table_name = 'recipients' AND column_name = 'legal_name_enc')
       ORDER BY table_name, column_name`);
    expect(cols.map((c) => [c.table_name, c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['recipients', 'legal_name_enc', 'text', 'YES'],
      ['transfers', 'delivery_business_days', 'smallint', 'YES'],
      ['transfers', 'disclosure_snapshot', 'jsonb', 'YES'],
    ]);
  });

  it('an old-shaped row reads NULL', async () => {
    const repo = createTransferRepo(db);
    const t = makeTransfer();
    await repo.saveTransfer(t);
    const raw = await rows<{ delivery_business_days: number | null; disclosure_snapshot: unknown }>(db,
      `SELECT delivery_business_days, disclosure_snapshot FROM transfers WHERE id = '${t.id}'`);
    expect(raw).toEqual([{ delivery_business_days: null, disclosure_snapshot: null }]);
    expect(await repo.getTransfer(t.id)).not.toHaveProperty('deliveryBusinessDays');

    await createRecipientRepo(db).upsertRecipient('default', '15550000001', {
      name: 'R', recipientPhone: '919000000000', payoutMethod: 'bank', payoutDestination: '000011112222|HDFC0000001',
      lastUsedAt: new Date().toISOString(),
    });
    const rec = await rows<{ legal_name_enc: string | null }>(db,
      `SELECT legal_name_enc FROM recipients WHERE partner_id = 'default' AND sender_phone = '15550000001'`);
    expect(rec).toEqual([{ legal_name_enc: null }]);
  });

  it('deliveryBusinessDays round-trips, and 0 survives (never the truthiness pattern)', async () => {
    const repo = createTransferRepo(db);
    const three = makeTransfer({ deliveryBusinessDays: 3 });
    await repo.saveTransfer(three);
    expect((await repo.getTransfer(three.id))?.deliveryBusinessDays).toBe(3);

    const zero = makeTransfer({ deliveryBusinessDays: 0 });
    await repo.saveTransfer(zero);
    // The default getTransfer is the MASKED read: it keeps the field.
    const got = await repo.getTransfer(zero.id);
    expect(got?.deliveryBusinessDays).toBe(0);
    expect(got).toHaveProperty('deliveryBusinessDays', 0);
    const raw = await rows<{ delivery_business_days: number | null }>(db,
      `SELECT delivery_business_days FROM transfers WHERE id = '${zero.id}'`);
    expect(raw[0].delivery_business_days).toBe(0);
  });

  it('it is WRITE-ONCE: saveTransfer\'s conflict-update never changes or clears it', async () => {
    const repo = createTransferRepo(db);
    const t = makeTransfer({ deliveryBusinessDays: 2 });
    await repo.saveTransfer(t);
    await repo.saveTransfer({ ...t, deliveryBusinessDays: undefined, adminNote: 'x' });
    expect(await repo.getTransfer(t.id)).toMatchObject({ deliveryBusinessDays: 2, adminNote: 'x' });
    await repo.saveTransfer({ ...t, deliveryBusinessDays: 5, adminNote: 'x' });
    expect(await repo.getTransfer(t.id)).toMatchObject({ deliveryBusinessDays: 2, adminNote: 'x' });
  });

  it('the snapshot column is not on the domain Transfer', async () => {
    const repo = createTransferRepo(db);
    const t = makeTransfer();
    await repo.saveTransfer(t);
    await db.execute(sql.raw(`UPDATE transfers SET disclosure_snapshot = '{"v":1}'::jsonb WHERE id = '${t.id}'`));
    const got = await repo.getTransfer(t.id);
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty('disclosureSnapshot');
    // A read-modify-write leaves the raw column as it was.
    await repo.saveTransfer({ ...got!, adminNote: 'rmw' });
    const raw = await rows<{ disclosure_snapshot: unknown; admin_note: string | null }>(db,
      `SELECT disclosure_snapshot, admin_note FROM transfers WHERE id = '${t.id}'`);
    expect(raw).toEqual([{ disclosure_snapshot: { v: 1 }, admin_note: 'rmw' }]);
  });
});
