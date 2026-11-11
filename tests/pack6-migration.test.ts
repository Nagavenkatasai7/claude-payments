import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { findDestructive } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';

// Fix pack 6 T1 (migration 0040, contracts P1/P2): the customer's E-SIGN consent.
// Three NULLABLE columns on customers, no default, no backfill. ADDITIVE ONLY:
// pack 5 and main never name them, and their saveCustomer upsert never names them.

const FILE = join(process.cwd(), 'drizzle/0040_customer_esign_consent.sql');
const TS = 'timestamp with time zone';
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;

describe('drizzle/0040_customer_esign_consent.sql', () => {
  const body = readFileSync(FILE, 'utf8');
  const statements = body
    .split('\n')
    .filter((l) => !/^--(?!>)/.test(l) && l.trim() !== '') // comment lines, never the `--> statement-breakpoint` line
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  it('0040 opens with lock_timeout, then exactly three ADD COLUMNs on customers', () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s';`,
      'ALTER TABLE "customers" ADD COLUMN "esign_consent_version" text;',
      'ALTER TABLE "customers" ADD COLUMN "esign_consented_at" timestamp with time zone;',
      'ALTER TABLE "customers" ADD COLUMN "esign_withdrawn_at" timestamp with time zone;',
    ]);
    expect(statements.some((s) => /DEFAULT|NOT NULL|CHECK|INDEX/i.test(s))).toBe(false);
  });

  it('the 0040 header says additive and safe for the build in production', () => {
    expect(body).toContain('PURELY ADDITIVE');
    expect(body).toContain('SAFE FOR THE BUILD IN PRODUCTION');
    expect(body).toContain('Rollback');
  });

  it('passes the CI migration guard (no destructive statement)', () => {
    expect(findDestructive(body)).toEqual([]);
  });

  it('the journal carries it at idx 40, after 0039', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0040_customer_esign_consent');
    const prev = journal.entries.find((e) => e.tag === '0039_rail_messages');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(40);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });
});

describe('0040 customer E-SIGN consent columns (applied)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('the three columns exist, nullable, no default, with the agreed types', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(db,
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'customers' AND column_name LIKE 'esign_%' ORDER BY ordinal_position`);
    expect(cols).toEqual([
      { column_name: 'esign_consent_version', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'esign_consented_at', data_type: TS, is_nullable: 'YES', column_default: null },
      { column_name: 'esign_withdrawn_at', data_type: TS, is_nullable: 'YES', column_default: null },
    ]);
  });

  it('an old-shaped insert (no consent columns) reads NULL in all three', async () => {
    await db.execute(sql.raw(`INSERT INTO customers (phone, partner_id, first_seen_at, sender_country, kyc_status)
      VALUES ('15551230601', 'default', now(), 'US', 'not_started')`));
    expect(await rows(db, `SELECT esign_consent_version, esign_consented_at, esign_withdrawn_at FROM customers WHERE phone = '15551230601'`))
      .toEqual([{ esign_consent_version: null, esign_consented_at: null, esign_withdrawn_at: null }]);
  });
});
