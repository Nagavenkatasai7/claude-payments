import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { findDestructive } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Step 0 FX-7 (migration 0030): five nullable, write-once provenance columns on
// `transfers` (fx_expires_at: review finding 1, the partner push's expiry). ADDITIVE ONLY, so it is applied to production BEFORE the merge
// while the old build (explicit column lists that never name them) still serves.

let seq = 0;
const makeTransfer = (o: Partial<Transfer> = {}): Transfer => ({
  id: `t_prov_${++seq}`, phone: '15550000001', amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85,
  amountInr: 8500, recipientName: 'R', recipientPhone: '919000000000', payoutMethod: 'bank',
  payoutDestination: '000011112222|HDFC0000001', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
  complianceReasons: [], status: 'awaiting_payment', createdAt: new Date().toISOString(), sourceCountry: 'US',
  sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
  amountSource: 100, feeSource: 0, totalChargeSource: 100, ...o,
});

const FILE = join(process.cwd(), 'drizzle/0030_fx_provenance.sql');
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;

describe('drizzle/0030_fx_provenance.sql', () => {
  const body = readFileSync(FILE, 'utf8');
  const statements = body
    .split('\n')
    .filter((l) => !l.startsWith('--') && l.trim() !== '')
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  it('is additive: lock_timeout, then five nullable ADD COLUMNs with no DEFAULT or constraint', () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(statements.slice(1)).toEqual([
      'ALTER TABLE "transfers" ADD COLUMN "fx_as_of" date;',
      'ALTER TABLE "transfers" ADD COLUMN "fx_fetched_at" timestamp with time zone;',
      'ALTER TABLE "transfers" ADD COLUMN "fx_source" text;',
      'ALTER TABLE "transfers" ADD COLUMN "fx_provider" text;',
      'ALTER TABLE "transfers" ADD COLUMN "fx_expires_at" timestamp with time zone;',
    ]);
  });

  it('passes the CI migration guard (no destructive statement)', () => {
    expect(findDestructive(body)).toEqual([]);
  });

  it('the journal carries it by tag at idx 30, after 0029', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const at = journal.entries.findIndex((e) => e.tag === '0030_fx_provenance');
    expect(at).toBeGreaterThan(0);
    const entry = journal.entries[at];
    const prev = journal.entries.find((e) => e.tag === '0029_feature_flags');
    expect(entry.idx).toBe(30);
    expect(prev).toBeDefined();
    expect(entry.when).toBeGreaterThan(prev!.when);
  });
});

describe('transfers provenance columns (applied)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('exist, nullable, with the agreed types', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'transfers' AND column_name LIKE 'fx\\_%' AND column_name <> 'fx_rate' ORDER BY column_name`);
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['fx_as_of', 'date', 'YES'],
      ['fx_expires_at', 'timestamp with time zone', 'YES'],
      ['fx_fetched_at', 'timestamp with time zone', 'YES'],
      ['fx_provider', 'text', 'YES'],
      ['fx_source', 'text', 'YES'],
    ]);
  });

  it('round-trips through the repo (date stays a YYYY-MM-DD string)', async () => {
    const repo = createTransferRepo(db);
    const t = makeTransfer({
      fxAsOf: '2026-10-02', fxFetchedAt: '2026-10-05T12:00:00.000Z', fxSource: 'platform', fxProvider: 'frankfurter-v1-ecb',
    });
    await repo.saveTransfer(t);
    const got = await repo.getTransfer(t.id);
    expect(got).toMatchObject({
      fxAsOf: '2026-10-02', fxFetchedAt: '2026-10-05T12:00:00.000Z', fxSource: 'platform', fxProvider: 'frankfurter-v1-ecb',
    });
    expect(got).not.toHaveProperty('fxExpiresAt');
    const p = makeTransfer({ fxSource: 'partner_push', fxProvider: 'partner', fxExpiresAt: '2026-10-05T12:05:00.000Z' });
    await repo.saveTransfer(p);
    expect((await repo.getTransfer(p.id))?.fxExpiresAt).toBe('2026-10-05T12:05:00.000Z');
  });

  it('a row with no provenance reads with the fields absent (old-build and legacy rows)', async () => {
    const repo = createTransferRepo(db);
    const t = makeTransfer();
    await repo.saveTransfer(t);
    const got = await repo.getTransfer(t.id);
    expect(got).not.toHaveProperty('fxAsOf');
    expect(got).not.toHaveProperty('fxFetchedAt');
    expect(got).not.toHaveProperty('fxSource');
    expect(got).not.toHaveProperty('fxProvider');
    expect(got).not.toHaveProperty('fxExpiresAt');
  });

  it('is WRITE-ONCE: saveTransfer\'s conflict-update never changes or clears it', async () => {
    const repo = createTransferRepo(db);
    const exp = '2026-10-05T12:05:00.000Z';
    const t = makeTransfer({ fxAsOf: '2026-10-02', fxFetchedAt: '2026-10-05T12:00:00.000Z', fxSource: 'partner_push', fxProvider: 'partner', fxExpiresAt: exp });
    await repo.saveTransfer(t);
    // A read-modify-write of a legacy-shaped object (no provenance) and an
    // attempt to rewrite it both leave the first values in place.
    await repo.saveTransfer({ ...t, fxAsOf: undefined, fxFetchedAt: undefined, fxSource: undefined, fxProvider: undefined, fxExpiresAt: undefined, adminNote: 'x' });
    await repo.saveTransfer({ ...t, fxAsOf: '2026-01-01', fxSource: 'platform', fxExpiresAt: '2027-01-01T00:00:00.000Z', adminNote: 'x' });
    const got = await repo.getTransfer(t.id);
    expect(got).toMatchObject({ fxAsOf: '2026-10-02', fxSource: 'partner_push', fxProvider: 'partner', fxExpiresAt: exp, adminNote: 'x' });
  });
});
