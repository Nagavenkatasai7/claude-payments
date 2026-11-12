import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { findDestructive, parseOverride } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';

// Fix pack 8 T1 (migration 0042, contract P1): the destination register table
// partner_corridors (named composite PK, FK to partners, no CHECK, no trigger),
// three NULLABLE columns on customers (state of residence), three on tickets
// (Reg E class, first notice, due date) + one partial index, two on transfers
// (payout blind index, purpose source) + two partial indexes (the bidx index and
// the recipient-digits expression index the India beneficiary count uses).
// Additive only: no migration-guard marker.

const DRIZZLE = join(process.cwd(), 'drizzle');
const TAG = readdirSync(DRIZZLE).find((f) => /^0042_.*\.sql$/.test(f))?.replace(/\.sql$/, '') ?? '0042_missing';
const FILE = join(DRIZZLE, `${TAG}.sql`);
const TS = 'timestamp with time zone';
const PG = { fk: '23503', unique: '23505' } as const;
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;
const exec = (db: Db, q: string) => db.execute(sql.raw(q));
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
  expect(err, 'expected the statement to be rejected').not.toBeNull();
  expect(err?.code ?? err?.cause?.code).toBe(code);
};

const reattestDue = () => new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
const insertCorridor = (db: Db, o: { partner?: string; cc?: string; status?: string; rulePack?: string | null } = {}) =>
  exec(db, `INSERT INTO partner_corridors (partner_id, destination_country, status, rule_pack, attestation_ref, reattest_due, recorded_by)
    VALUES ('${o.partner ?? 'pa'}', '${o.cc ?? 'IN'}', '${o.status ?? 'active'}', ${o.rulePack === undefined ? 'NULL' : o.rulePack === null ? 'NULL' : `'${o.rulePack}'`}, 'ref-1', '${reattestDue()}', 'admin_1')`);

describe('drizzle/0042 migration file', () => {
  const body = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
  const statements = body
    .split('\n')
    .filter((l) => !/^--(?!>)/.test(l) && l.trim() !== '') // comment lines, never the `--> statement-breakpoint` line
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  const createTable = statements.find((s) => s.startsWith('CREATE TABLE "partner_corridors"')) ?? '';

  it('opens with lock_timeout, then CREATE TABLE "partner_corridors"', () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(statements[1]?.startsWith('CREATE TABLE "partner_corridors"')).toBe(true);
    expect(statements.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(1);
  });

  it('partner_corridors has the P1 columns, the named PK and no CHECK', () => {
    for (const line of [
      '"partner_id" text NOT NULL',
      '"destination_country" text NOT NULL',
      '"status" text NOT NULL',
      '"rule_pack" text,',
      `"purpose_code_map" jsonb DEFAULT '{}'::jsonb NOT NULL`,
      '"attestation_ref" text NOT NULL',
      '"attestation_sha256" text,',
      '"recipient_notices" boolean DEFAULT false NOT NULL',
      '"travel_dob_from_usd" numeric(12, 2),',
      '"travel_full_from_usd" numeric(12, 2),',
      '"reattest_due" date NOT NULL',
      '"recorded_by" text NOT NULL',
      `"recorded_at" ${TS} DEFAULT now() NOT NULL`,
      '"attested_by" text,',
      `"attested_at" ${TS},`,
      '"attested_hash" text,',
      'CONSTRAINT "partner_corridors_pk" PRIMARY KEY("partner_id","destination_country")',
    ]) {
      expect(createTable, line).toContain(line);
    }
    expect(createTable).not.toMatch(/\bCHECK\b/);
    expect(statements.join('\n')).not.toMatch(/\bCHECK\b/);
    expect(statements[2]).toBe(
      'ALTER TABLE "partner_corridors" ADD CONSTRAINT "partner_corridors_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;',
    );
  });

  it('exactly the eight ADD COLUMN statements, all nullable', () => {
    const adds = statements.filter((s) => /^ALTER TABLE "\w+" ADD COLUMN/.test(s));
    expect(adds).toEqual([
      'ALTER TABLE "customers" ADD COLUMN "residence_state" text;',
      'ALTER TABLE "customers" ADD COLUMN "residence_state_source" text;',
      `ALTER TABLE "customers" ADD COLUMN "residence_state_at" ${TS};`,
      'ALTER TABLE "tickets" ADD COLUMN "reg_class" text;',
      `ALTER TABLE "tickets" ADD COLUMN "first_notice_at" ${TS};`,
      `ALTER TABLE "tickets" ADD COLUMN "due_at" ${TS};`,
      'ALTER TABLE "transfers" ADD COLUMN "payout_dest_bidx" text;',
      'ALTER TABLE "transfers" ADD COLUMN "purpose_source" text;',
    ]);
    for (const a of adds) {
      expect(a).not.toMatch(/NOT NULL/);
      expect(a).not.toMatch(/DEFAULT/);
    }
  });

  it('exactly three plain partial indexes, in P1 order after their columns', () => {
    const idx = statements.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s));
    expect(idx).toEqual([
      'CREATE INDEX "tickets_reg_due" ON "tickets" USING btree ("partner_id","due_at") WHERE "tickets"."reg_class" IS NOT NULL;',
      `CREATE INDEX "transfers_partner_payout_bidx" ON "transfers" USING btree ("partner_id","payout_dest_bidx","created_at") WHERE "transfers"."payout_dest_bidx" IS NOT NULL AND "transfers"."destination_country" = 'IN';`,
      `CREATE INDEX "transfers_partner_rcpt_digits" ON "transfers" USING btree ("partner_id",regexp_replace("recipient_phone", '[^0-9]', '', 'g'),"created_at") WHERE "transfers"."destination_country" = 'IN' AND "transfers"."environment" = 'live';`,
    ]);
    expect(statements.join('\n')).not.toMatch(/\bUNIQUE\b/);
    expect(statements.join('\n')).not.toMatch(/\bCONCURRENTLY\b/);
    // P1 order: lock, table, FK, customers, tickets + its index, transfers + its two indexes.
    const pos = (needle: string) => statements.findIndex((s) => s.includes(needle));
    expect(pos('"residence_state_at"')).toBeLessThan(pos('"reg_class" text'));
    expect(pos('"due_at" timestamp')).toBeLessThan(pos('"tickets_reg_due"'));
    expect(pos('"tickets_reg_due"')).toBeLessThan(pos('"payout_dest_bidx" text'));
    expect(pos('"purpose_source"')).toBeLessThan(pos('"transfers_partner_payout_bidx"'));
    expect(pos('"transfers_partner_payout_bidx"')).toBe(statements.length - 2);
    expect(pos('"transfers_partner_rcpt_digits"')).toBe(statements.length - 1);
    expect(statements).toHaveLength(14);
  });

  it('additive only: the guard finds nothing destructive and there is no marker', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(findDestructive(body)).toEqual([]);
    expect(parseOverride(body)).toBeNull();
    const code = statements.join('\n');
    for (const bad of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i, /CREATE\s+OR\s+REPLACE\s+FUNCTION/i]) {
      expect(code).not.toMatch(bad);
    }
    expect(body).not.toMatch(/migration-guard:/);
  });

  it('the header says why it is safe for the serving pack 7 build', () => {
    const header = body.split('\n').filter((l) => l.startsWith('--') && !l.startsWith('-->')).join(' ');
    for (const s of ['partner_corridors', 'SAFE FOR THE SERVING PACK 7 BUILD', 'nullable', 'explicit column lists', 'SHARE lock', 'Rollback']) {
      expect(header, s).toContain(s);
    }
  });

  it('the header names the ACCESS EXCLUSIVE window of ADD COLUMN, not "reads go on" (early review FA1)', () => {
    const header = body.split('\n').filter((l) => l.startsWith('--') && !l.startsWith('-->')).join(' ');
    expect(header).toContain('ACCESS EXCLUSIVE');
    expect(header).not.toContain('reads go on');
    for (const s of ['customers', 'tickets', 'transfers', 'COMMIT', 'lock_timeout', 'deadlock']) {
      expect(header, s).toContain(s);
    }
  });

  it('the journal carries it at idx 42, after 0041', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag.startsWith('0042_'));
    const prev = journal.entries.find((e) => e.tag === '0041_hold_reviews');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.tag).toBe(TAG);
    expect(entry!.idx).toBe(42);
    expect(entry!.when).toBeGreaterThan(prev!.when);
    const snap = join(DRIZZLE, 'meta/0042_snapshot.json');
    expect(existsSync(snap)).toBe(true);
    const s42 = JSON.parse(readFileSync(snap, 'utf8')) as { id: string; prevId: string };
    const s41 = JSON.parse(readFileSync(join(DRIZZLE, 'meta/0041_snapshot.json'), 'utf8')) as { id: string };
    expect(s42.prevId).toBe(s41.id);
  });
});

describe('0042 (applied)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pa');
  });

  it('partner_corridors columns, types and nullability', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'partner_corridors' ORDER BY ordinal_position`);
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['partner_id', 'text', 'NO'],
      ['destination_country', 'text', 'NO'],
      ['status', 'text', 'NO'],
      ['rule_pack', 'text', 'YES'],
      ['purpose_code_map', 'jsonb', 'NO'],
      ['attestation_ref', 'text', 'NO'],
      ['attestation_sha256', 'text', 'YES'],
      ['recipient_notices', 'boolean', 'NO'],
      ['travel_dob_from_usd', 'numeric', 'YES'],
      ['travel_full_from_usd', 'numeric', 'YES'],
      ['reattest_due', 'date', 'NO'],
      ['recorded_by', 'text', 'NO'],
      ['recorded_at', TS, 'NO'],
      ['attested_by', 'text', 'YES'],
      ['attested_at', TS, 'YES'],
      ['attested_hash', 'text', 'YES'],
    ]);
  });

  it('defaults: purpose_code_map {}, recipient_notices false, recorded_at now()', async () => {
    const before = Date.now();
    await insertCorridor(db);
    const [r] = await rows<{ purpose_code_map: unknown; recipient_notices: boolean; recorded_at: string | Date; attested_at: unknown }>(db,
      'SELECT purpose_code_map, recipient_notices, recorded_at, attested_at FROM partner_corridors');
    expect(r.purpose_code_map).toEqual({});
    expect(r.recipient_notices).toBe(false);
    expect(r.attested_at).toBeNull();
    const at = new Date(r.recorded_at).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('the PK refuses a second (partner, destination) row; the FK refuses an unknown partner; any status text is accepted', async () => {
    await insertCorridor(db);
    await rejectsWith(insertCorridor(db, { status: 'paused' }), PG.unique);
    await insertCorridor(db, { cc: 'MX', status: 'anything', rulePack: 'anything' }); // no CHECK: validated in code
    await rejectsWith(insertCorridor(db, { partner: 'no-such-partner' }), PG.fk);
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM partner_corridors')).toEqual([{ n: 2 }]);
  });

  it('every new column on customers, tickets and transfers is nullable with no default', async () => {
    const cols = await rows<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(db,
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE (table_name = 'customers' AND column_name IN ('residence_state','residence_state_source','residence_state_at'))
          OR (table_name = 'tickets' AND column_name IN ('reg_class','first_notice_at','due_at'))
          OR (table_name = 'transfers' AND column_name IN ('payout_dest_bidx','purpose_source'))
       ORDER BY table_name, ordinal_position`);
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'customers.residence_state', 'customers.residence_state_source', 'customers.residence_state_at',
      'tickets.reg_class', 'tickets.first_notice_at', 'tickets.due_at',
      'transfers.payout_dest_bidx', 'transfers.purpose_source',
    ]);
    for (const c of cols) {
      expect(c.is_nullable, c.column_name).toBe('YES');
      expect(c.column_default, c.column_name).toBeNull();
    }
  });

  it('all three indexes exist and are partial', async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('tickets_reg_due','transfers_partner_payout_bidx','transfers_partner_rcpt_digits') ORDER BY indexname`);
    expect(idx.map((i) => i.indexname)).toEqual(['tickets_reg_due', 'transfers_partner_payout_bidx', 'transfers_partner_rcpt_digits']);
    const [reg, bidx, digits] = idx.map((i) => i.indexdef);
    expect(reg).toMatch(/\(partner_id, due_at\) WHERE \(reg_class IS NOT NULL\)/);
    expect(bidx).toMatch(/\(partner_id, payout_dest_bidx, created_at\)/);
    expect(bidx).toContain('payout_dest_bidx IS NOT NULL');
    expect(bidx).toContain(`destination_country = 'IN'`);
    expect(digits).toContain('regexp_replace');
    expect(digits).toContain(`destination_country = 'IN'`);
    expect(digits).toContain(`environment = 'live'`);
    for (const d of [reg, bidx, digits]) expect(d).not.toMatch(/UNIQUE/);
  });

  it('a pack 7-shaped write still works and each new column reads back NULL', async () => {
    await seedPartnerTransfer(db, { id: 't1', partnerId: 'pa' });
    await exec(db, `INSERT INTO tickets (id, partner_id, kind, customer_phone, subject, status, priority, created_at, updated_at)
      VALUES ('tk1', 'pa', 'customer', '14155550101', 's', 'open', 'normal', now(), now())`);
    await exec(db, `INSERT INTO customers (phone, partner_id, first_seen_at, sender_country) VALUES ('15550000001', 'pa', now(), 'US')`);
    expect(await rows(db, `SELECT payout_dest_bidx, purpose_source FROM transfers WHERE id = 't1'`)).toEqual([
      { payout_dest_bidx: null, purpose_source: null },
    ]);
    expect(await rows(db, `SELECT reg_class, first_notice_at, due_at FROM tickets WHERE id = 'tk1'`)).toEqual([
      { reg_class: null, first_notice_at: null, due_at: null },
    ]);
    expect(await rows(db, `SELECT residence_state, residence_state_source, residence_state_at FROM customers WHERE phone = '15550000001'`)).toEqual([
      { residence_state: null, residence_state_source: null, residence_state_at: null },
    ]);
  });
});
