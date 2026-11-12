import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { findDestructive } from '../scripts/ci/migration-guard.mjs';
import type { Db } from '@/db/client';

// Fix pack 5 T7 (migration 0039, contracts P1/P2): the rail record. A NEW
// append-only table rail_messages (sealed exact body, its sha256, the signature
// header, owner and rail partner, transfer id, direction, kind), two indexes,
// one nullable partner_webhook_deliveries.body_sha256, and a plpgsql function
// with two row triggers. ADDITIVE ONLY: pack 4 and main never name any of it.

const FILE = join(process.cwd(), 'drizzle/0039_rail_messages.sql');
const TS = 'timestamp with time zone';
const SHA = 'a'.repeat(64);
const PG = { fk: '23503', check: '23514' } as const;
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
const insertRow = (db: Db, o: Partial<Record<'partner_id' | 'rail_partner_id' | 'transfer_id' | 'direction' | 'kind' | 'body_sha256', string>> = {}) => {
  const v = { partner_id: `'default'`, rail_partner_id: `'default'`, transfer_id: `'t_1'`, direction: '1', kind: `'settle'`, body_sha256: `'${SHA}'`, ...o };
  return exec(db, `INSERT INTO rail_messages (id, partner_id, rail_partner_id, transfer_id, direction, kind, body_enc, body_sha256)
    VALUES ('${uuid()}', ${v.partner_id}, ${v.rail_partner_id}, ${v.transfer_id}, ${v.direction}, ${v.kind}, 'v2.k0.sealed', ${v.body_sha256})`);
};

describe('drizzle/0039_rail_messages.sql', () => {
  const body = readFileSync(FILE, 'utf8');
  const statements = body
    .split('\n')
    .filter((l) => !/^--(?!>)/.test(l) && l.trim() !== '') // comment lines, never the `--> statement-breakpoint` line
    .join('\n')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

  it('0039 opens with lock_timeout, creates rail_messages, two indexes, the body_sha256 column, then the function and two triggers', () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(statements.filter((s) => s.startsWith('CREATE TABLE "rail_messages"'))).toHaveLength(1);
    const idx = statements.filter((s) => s.startsWith('CREATE INDEX'));
    expect(idx).toEqual([
      'CREATE INDEX "rail_messages_transfer" ON "rail_messages" USING btree ("transfer_id","created_at");',
      'CREATE INDEX "rail_messages_partner_created" ON "rail_messages" USING btree ("partner_id","created_at" DESC NULLS LAST);',
    ]);
    expect(statements).toContain('ALTER TABLE "partner_webhook_deliveries" ADD COLUMN "body_sha256" text;');
    const fn = statements.findIndex((s) => s.startsWith('CREATE OR REPLACE FUNCTION rail_messages_append_only()'));
    expect(fn).toBeGreaterThan(0);
    const triggers = statements.filter((s) => s.startsWith('CREATE OR REPLACE TRIGGER'));
    expect(triggers).toEqual([
      'CREATE OR REPLACE TRIGGER rail_messages_no_update BEFORE UPDATE ON "rail_messages" FOR EACH ROW EXECUTE FUNCTION rail_messages_append_only();',
      'CREATE OR REPLACE TRIGGER rail_messages_no_delete BEFORE DELETE ON "rail_messages" FOR EACH ROW EXECUTE FUNCTION rail_messages_append_only();',
    ]);
    // The function and the triggers come last, after every drizzle-kit statement.
    expect(statements.slice(fn)).toHaveLength(3);
    // No TRUNCATE trigger (freshDb truncates; 0019 rule): no statement names TRUNCATE.
    expect(statements.some((s) => /TRUNCATE/i.test(s))).toBe(false);
  });

  it('the 0039 header states the scope of the guarantee', () => {
    expect(body).toContain('NOT a privilege boundary');
    expect(body).toContain('TRUNCATE');
    const header = body.split('\n').filter((l) => l.startsWith('--')).map((l) => l.replace(/^--\s?/, '')).join(' ').replace(/\s+/g, ' ');
    expect(header).toContain(
      'Scope of the guarantee: the row trigger rejects UPDATE (other than a body_enc-only change) and DELETE from the application. It is NOT a privilege boundary while the app role owns the table: that role can TRUNCATE (no TRUNCATE trigger: freshDb), DISABLE or DROP the trigger, DROP the table, or overwrite body_enc through the re-seal exception (body_sha256 then no longer matches the opened body). A separate owner role is a follow-up.',
    );
  });

  it('passes the CI migration guard (no destructive statement)', () => {
    expect(findDestructive(body)).toEqual([]);
  });

  it('the journal carries it at idx 39, after 0038', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0039_rail_messages');
    const prev = journal.entries.find((e) => e.tag === '0038_pay_step_evidence');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(39);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });
});

describe('0039 rail_messages (applied)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('the table has the agreed columns, types and nullability', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'rail_messages' ORDER BY ordinal_position`);
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['partner_id', 'text', 'YES'],
      ['rail_partner_id', 'text', 'YES'],
      ['transfer_id', 'text', 'YES'],
      ['direction', 'smallint', 'NO'],
      ['kind', 'text', 'NO'],
      ['body_enc', 'text', 'NO'],
      ['body_sha256', 'text', 'NO'],
      ['signature_header', 'text', 'YES'],
      ['created_at', TS, 'NO'],
    ]);
  });

  it('CHECKs refuse a bad direction (3), a bad kind (ping), an upper-case or short sha256', async () => {
    await insertRow(db);
    await insertRow(db, { direction: '2', kind: `'callback'` });
    await insertRow(db, { kind: `'reverse'` });
    await rejectsWith(insertRow(db, { direction: '3' }), PG.check);
    await rejectsWith(insertRow(db, { kind: `'ping'` }), PG.check);
    await rejectsWith(insertRow(db, { body_sha256: `'${'A'.repeat(64)}'` }), PG.check);
    await rejectsWith(insertRow(db, { body_sha256: `'${'a'.repeat(63)}'` }), PG.check);
    expect(await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM rail_messages')).toEqual([{ n: 3 }]);
  });

  it('partner_id and rail_partner_id are FKs to partners; transfer_id is not', async () => {
    await rejectsWith(insertRow(db, { partner_id: `'no-such-partner'` }), PG.fk);
    await rejectsWith(insertRow(db, { rail_partner_id: `'no-such-partner'` }), PG.fk);
    // An unresolved callback keeps the claimed reference: no transfer row needed, owner NULL.
    await insertRow(db, { transfer_id: `'t_does_not_exist'`, partner_id: 'NULL', direction: '2', kind: `'callback'` });
    expect(await rows<{ transfer_id: string; partner_id: string | null }>(db, 'SELECT transfer_id, partner_id FROM rail_messages'))
      .toEqual([{ transfer_id: 't_does_not_exist', partner_id: null }]);
  });

  it('the two indexes exist on (transfer_id, created_at) and (partner_id, created_at DESC)', async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'rail_messages' AND indexname <> 'rail_messages_pkey' ORDER BY indexname`);
    expect(idx.map((i) => i.indexname)).toEqual(['rail_messages_partner_created', 'rail_messages_transfer']);
    expect(idx[0].indexdef).toMatch(/\(partner_id, created_at DESC NULLS LAST\)/);
    expect(idx[1].indexdef).toMatch(/\(transfer_id, created_at\)/);
  });

  it('partner_webhook_deliveries.body_sha256 is text, nullable, no default; an old-shaped insert leaves it NULL', async () => {
    const [col] = await rows<{ data_type: string; is_nullable: string; column_default: string | null }>(db,
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'partner_webhook_deliveries' AND column_name = 'body_sha256'`);
    expect(col).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
    await exec(db, `INSERT INTO partner_webhook_deliveries (partner_id, kind, subject_id, attempt, outcome) VALUES ('default', 'ping', NULL, 1, 'ok')`);
    expect(await rows<{ body_sha256: string | null }>(db, 'SELECT body_sha256 FROM partner_webhook_deliveries')).toEqual([{ body_sha256: null }]);
  });
});
