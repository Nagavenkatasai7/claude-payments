import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { findDestructive, parseOverride } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';

// Fix pack 7 T3 (migration 0041, contracts P1/P20, DP8): the append-only
// hold_reviews table (two CHECKs, two unique indexes, the queue index, FKs to
// transfers and partners, UPDATE/DELETE row triggers), one nullable
// customers.screening_watchlist_at, and the rail_messages kind CHECK widened
// with 'event' (DROP + ADD ... NOT VALID) under ONE reviewed file-level marker.

const FILE = join(process.cwd(), 'drizzle/0041_hold_reviews.sql');
const TS = 'timestamp with time zone';
const SHA = 'a'.repeat(64);
const PG = { fk: '23503', check: '23514', unique: '23505', raise: 'P0001' } as const;
const MARKER_REASON = "widens the rail_messages kind CHECK with 'event'; the serving build never writes or reads kind event";
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;
const exec = (db: Db, q: string) => db.execute(sql.raw(q));
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
  expect(err, 'expected the statement to be rejected').not.toBeNull();
  expect(err?.code ?? err?.cause?.code).toBe(code);
};

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
type ReviewCols = 'transfer_id' | 'partner_id' | 'hold_class' | 'reasons_fp' | 'step' | 'final' | 'disposition' | 'actor' | 'actor_scope';
const insertReview = (db: Db, o: Partial<Record<ReviewCols, string>> = {}) => {
  const v = {
    transfer_id: `'t1'`, partner_id: `'pa'`, hold_class: `'sanctions'`, reasons_fp: `'fp1'`, step: '1', final: 'false',
    disposition: `'cleared'`, actor: `'staff_1'`, actor_scope: `'partner'`, ...o,
  };
  return exec(db, `INSERT INTO hold_reviews (id, transfer_id, partner_id, hold_class, reasons_fp, step, final, disposition, reason, actor, actor_scope)
    VALUES ('${uuid()}', ${v.transfer_id}, ${v.partner_id}, ${v.hold_class}, ${v.reasons_fp}, ${v.step}, ${v.final}, ${v.disposition}, 'checked the documents', ${v.actor}, ${v.actor_scope})`);
};
const insertRail = (db: Db, kind: string) =>
  exec(db, `INSERT INTO rail_messages (id, partner_id, rail_partner_id, transfer_id, direction, kind, body_enc, body_sha256)
    VALUES ('${uuid()}', 'default', 'default', 't_1', 1, '${kind}', 'v2.k0.sealed', '${SHA}')`);

describe('drizzle/0041_hold_reviews.sql', () => {
  const body = readFileSync(FILE, 'utf8');
  const statements = body
    .split('\n')
    .filter((l) => !/^--(?!>)/.test(l) && l.trim() !== '') // comment lines, never the `--> statement-breakpoint` line
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  const createTable = statements.find((s) => s.startsWith('CREATE TABLE "hold_reviews"')) ?? '';

  it('opens with lock_timeout, then CREATE TABLE "hold_reviews"', () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(statements[1].startsWith('CREATE TABLE "hold_reviews"')).toBe(true);
    expect(statements.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(1);
  });

  it('hold_reviews has exactly the two CHECKs on step and actor_scope', () => {
    expect(createTable).toContain('CONSTRAINT "hold_reviews_step" CHECK ("hold_reviews"."step" IN (1, 2))');
    expect(createTable).toContain(`CONSTRAINT "hold_reviews_actor_scope" CHECK ("hold_reviews"."actor_scope" IN ('partner','platform'))`);
    expect(createTable.match(/\bCHECK\b/g)).toHaveLength(2);
    expect(createTable).toContain(`"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL`);
    expect(statements).toContain(
      'ALTER TABLE "hold_reviews" ADD CONSTRAINT "hold_reviews_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;',
    );
    expect(statements).toContain(
      'ALTER TABLE "hold_reviews" ADD CONSTRAINT "hold_reviews_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;',
    );
  });

  it('two unique indexes and the queue index', () => {
    expect(statements.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s))).toEqual([
      'CREATE UNIQUE INDEX "hold_reviews_cycle_step" ON "hold_reviews" USING btree ("transfer_id","hold_class","reasons_fp","step");',
      'CREATE UNIQUE INDEX "hold_reviews_cycle_actor" ON "hold_reviews" USING btree ("transfer_id","hold_class","reasons_fp","actor");',
      'CREATE INDEX "hold_reviews_partner_queue" ON "hold_reviews" USING btree ("partner_id","transfer_id","created_at");',
    ]);
  });

  it('the function and the two triggers', () => {
    expect(statements.filter((s) => s.startsWith('CREATE OR REPLACE FUNCTION'))).toHaveLength(1);
    const fn = statements.find((s) => s.startsWith('CREATE OR REPLACE FUNCTION hold_reviews_append_only()')) ?? '';
    expect(fn).toContain(`RAISE EXCEPTION 'hold_reviews is append-only: % of row % rejected', TG_OP, OLD.id USING ERRCODE = 'raise_exception';`);
    expect(fn).not.toContain('RETURN NEW'); // no re-seal exception: nothing is sealed
    expect(statements.filter((s) => s.startsWith('CREATE OR REPLACE TRIGGER'))).toEqual([
      'CREATE OR REPLACE TRIGGER hold_reviews_no_update BEFORE UPDATE ON "hold_reviews" FOR EACH ROW EXECUTE FUNCTION hold_reviews_append_only();',
      'CREATE OR REPLACE TRIGGER hold_reviews_no_delete BEFORE DELETE ON "hold_reviews" FOR EACH ROW EXECUTE FUNCTION hold_reviews_append_only();',
    ]);
    expect(statements.some((s) => /TRUNCATE/i.test(s))).toBe(false);
  });

  it('customers gains screening_watchlist_at, nullable, and nothing else changes on customers', () => {
    const onCustomers = statements.filter((s) => s.includes('"customers"'));
    expect(onCustomers).toEqual(['ALTER TABLE "customers" ADD COLUMN "screening_watchlist_at" timestamp with time zone;']);
    expect(onCustomers[0]).not.toMatch(/NOT NULL/);
  });

  it('the widened CHECK is NOT VALID', () => {
    const add = statements.filter((s) => s.startsWith('ALTER TABLE "rail_messages" ADD CONSTRAINT'));
    expect(add).toEqual([
      `ALTER TABLE "rail_messages" ADD CONSTRAINT "rail_messages_kind" CHECK ("rail_messages"."kind" IN ('settle','reverse','callback','event')) NOT VALID;`,
    ]);
    expect(body).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
  });

  it('the marker covers exactly one destructive statement (DP8)', () => {
    const found = findDestructive(body);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('drop');
    expect(found[0].text).toContain('DROP CONSTRAINT "rail_messages_kind"');
    expect(parseOverride(body)).toEqual({ afterDeploy: false, reason: MARKER_REASON });
    expect(MARKER_REASON.length).toBeGreaterThanOrEqual(10);
    expect(body.match(/migration-guard:\s*allow-destructive/g)).toHaveLength(1);
    const drop = statements.indexOf('ALTER TABLE "rail_messages" DROP CONSTRAINT "rail_messages_kind";');
    expect(drop).toBeGreaterThan(0);
    expect(statements[drop + 1]).toMatch(/^ALTER TABLE "rail_messages" ADD CONSTRAINT "rail_messages_kind" CHECK/);
    expect(drop + 1).toBe(statements.length - 1); // the pair closes the file
  });

  it('the header says why it is safe for the serving build', () => {
    const header = body.split('\n').filter((l) => l.startsWith('--') && !l.startsWith('-->')).join(' ');
    for (const s of ['hold_reviews', 'append-only', 'NOT a privilege boundary', 'the serving build never writes or reads kind event']) {
      expect(header).toContain(s);
    }
  });

  it('the journal carries it at idx 41, after 0040', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0041_hold_reviews');
    const prev = journal.entries.find((e) => e.tag === '0040_customer_esign_consent');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(41);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });
});

describe('0041 hold_reviews (applied)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pa');
    await seedPartnerTransfer(db, { id: 't1', partnerId: 'pa' });
  });

  it('customers.screening_watchlist_at exists, timestamptz, nullable, default null for existing rows', async () => {
    const [col] = await rows<{ data_type: string; is_nullable: string; column_default: string | null }>(db,
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'screening_watchlist_at'`);
    expect(col).toEqual({ data_type: TS, is_nullable: 'YES', column_default: null });
    await exec(db, `INSERT INTO customers (phone, partner_id, first_seen_at, sender_country) VALUES ('15550000001', 'pa', now(), 'US')`);
    expect(await rows<{ screening_watchlist_at: unknown }>(db, 'SELECT screening_watchlist_at FROM customers')).toEqual([{ screening_watchlist_at: null }]);
  });

  it('columns, types and nullability', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'hold_reviews' ORDER BY ordinal_position`);
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['transfer_id', 'text', 'NO'],
      ['partner_id', 'text', 'NO'],
      ['hold_class', 'text', 'NO'],
      ['reasons_fp', 'text', 'NO'],
      ['step', 'smallint', 'NO'],
      ['final', 'boolean', 'NO'],
      ['disposition', 'text', 'NO'],
      ['reason', 'text', 'NO'],
      ['evidence', 'jsonb', 'NO'],
      ['actor', 'text', 'NO'],
      ['actor_scope', 'text', 'NO'],
      ['created_at', TS, 'NO'],
    ]);
  });

  it('evidence defaults to {} and created_at to now()', async () => {
    const before = Date.now();
    await insertReview(db);
    const [r] = await rows<{ evidence: unknown; created_at: string | Date }>(db, 'SELECT evidence, created_at FROM hold_reviews');
    expect(r.evidence).toEqual({});
    const at = new Date(r.created_at).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("CHECKs refuse step 3 and actor_scope 'x'; any hold_class and disposition are accepted", async () => {
    await rejectsWith(insertReview(db, { step: '3' }), PG.check);
    await rejectsWith(insertReview(db, { actor_scope: `'x'` }), PG.check);
    await insertReview(db, { hold_class: `'anything'`, disposition: `'anything'`, actor_scope: `'platform'` });
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hold_reviews')).toEqual([{ n: 1 }]);
  });

  it('FKs refuse an unknown transfer and an unknown partner', async () => {
    await rejectsWith(insertReview(db, { transfer_id: `'t_missing'` }), PG.fk);
    await rejectsWith(insertReview(db, { partner_id: `'no-such-partner'` }), PG.fk);
  });

  it('unique (transfer, class, fp, step) and (transfer, class, fp, actor); a new reasons_fp is a new cycle', async () => {
    await insertReview(db);
    await rejectsWith(insertReview(db, { actor: `'staff_2'` }), PG.unique); // a second step 1
    await rejectsWith(insertReview(db, { step: '2', final: 'true' }), PG.unique); // the same actor at step 2
    await insertReview(db, { step: '2', final: 'true', actor: `'staff_2'` });
    await insertReview(db, { reasons_fp: `'fp2'` }); // same step and actor, a new cycle
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hold_reviews')).toEqual([{ n: 3 }]);
  });

  it('UPDATE and DELETE raise (append-only); TRUNCATE works', async () => {
    await insertReview(db);
    await rejectsWith(exec(db, `UPDATE hold_reviews SET disposition = 'other'`), PG.raise);
    await rejectsWith(exec(db, `UPDATE hold_reviews SET evidence = '{"a":1}'::jsonb`), PG.raise);
    await rejectsWith(exec(db, 'DELETE FROM hold_reviews'), PG.raise);
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hold_reviews')).toEqual([{ n: 1 }]);
    await exec(db, 'TRUNCATE hold_reviews');
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hold_reviews')).toEqual([{ n: 0 }]);
  });

  it('the queue index is (partner_id, transfer_id, created_at)', async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'hold_reviews' AND indexname <> 'hold_reviews_pkey' ORDER BY indexname`);
    expect(idx.map((i) => i.indexname)).toEqual(['hold_reviews_cycle_actor', 'hold_reviews_cycle_step', 'hold_reviews_partner_queue']);
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX .*\(transfer_id, hold_class, reasons_fp, actor\)/);
    expect(idx[1].indexdef).toMatch(/UNIQUE INDEX .*\(transfer_id, hold_class, reasons_fp, step\)/);
    expect(idx[2].indexdef).toMatch(/\(partner_id, transfer_id, created_at\)/);
  });
});

describe('0041 rail_messages kind (applied)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it("kind 'event' is accepted; 'ping' is still refused; settle, reverse and callback still pass", async () => {
    for (const k of ['settle', 'reverse', 'callback', 'event']) await insertRail(db, k);
    await rejectsWith(insertRail(db, 'ping'), PG.check);
    expect(await rows<{ kind: string }>(db, 'SELECT kind FROM rail_messages ORDER BY kind')).toEqual(
      ['callback', 'event', 'reverse', 'settle'].map((kind) => ({ kind })),
    );
  });
});
