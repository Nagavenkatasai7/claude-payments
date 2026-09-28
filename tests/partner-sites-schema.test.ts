import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// UI redesign M1 (migration 0026): partner_sites is a NEW, empty table with no reader or writer
// yet. These pin its shape and constraints against the migrated PGlite DB.
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;
const ins = (db: Db, v: string) => db.execute(sql.raw(`INSERT INTO partner_sites (partner_id, slug, accent_color) VALUES (${v})`));
// Pin the SQLSTATE so a rejection can't pass vacuously (e.g. 42P01 "relation does not exist").
const PG = { fk: '23503', unique: '23505', check: '23514' } as const;
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
  expect(err, 'expected the insert to be rejected').not.toBeNull();
  expect(err?.code ?? err?.cause?.code).toBe(code);
};

describe('partner_sites table (migration 0026)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('has the agreed columns, types and nullability', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'partner_sites' ORDER BY ordinal_position`);
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['partner_id', 'text', 'NO'],
      ['slug', 'text', 'YES'],
      ['accent_color', 'text', 'YES'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });
  it('partner_id is the PK and an FK to partners (unknown partner rejected)', async () => {
    await ins(db, `'default', 'acme', '#0c5bd2'`);
    await rejectsWith(ins(db, `'no-such-partner', 'other', NULL`), PG.fk);
    await rejectsWith(ins(db, `'default', 'second', NULL`), PG.unique); // PK: one site row per partner
  });
  it('slug is unique but nullable (many partners without a slug)', async () => {
    await db.execute(sql.raw(`INSERT INTO partners (id, name) VALUES ('p2', 'P2'), ('p3', 'P3')`));
    await ins(db, `'p2', NULL, NULL`);
    await ins(db, `'p3', NULL, NULL`);
    await ins(db, `'default', 'acme', NULL`);
    await db.execute(sql.raw(`INSERT INTO partners (id, name) VALUES ('p4', 'P4')`));
    await rejectsWith(ins(db, `'p4', 'acme', NULL`), PG.unique);
  });
  it.each(['Acme', 'ac', 'a_b', '-acme', 'acme-', 'a'.repeat(31), 'acme.x', 'ac me'])('CHECK rejects slug %j', async (s) => {
    await rejectsWith(ins(db, `'default', '${s}', NULL`), PG.check);
  });
  it.each(['acme', 'a1b', 'my-remit-co', 'a'.repeat(30)])('CHECK accepts slug %j', async (s) => {
    await ins(db, `'default', '${s}', NULL`);
  });
  // Round 1 (security LOW): a label with '--' in positions 3-4 is reserved in DNS (R-LDH:
  // 'xn--' punycode and every '??--' form), so it can never be a partner subdomain.
  it.each(['xn--80ak6aa92e', 'ac--me', 'ab--cd'])('CHECK rejects the reserved ??-- slug %j', async (s) => {
    await rejectsWith(ins(db, `'default', '${s}', NULL`), PG.check);
  });
  it.each(['abc--de', 'a-b-c'])('CHECK still accepts %j (hyphens outside positions 3-4)', async (s) => {
    await ins(db, `'default', '${s}', NULL`);
  });
  it('the reserved-label CHECK is its own named constraint', async () => {
    const names = await rows<{ conname: string }>(db,
      `SELECT conname FROM pg_constraint WHERE conrelid = 'partner_sites'::regclass AND contype = 'c' ORDER BY conname`);
    expect(names.map((n) => n.conname)).toEqual([
      'partner_sites_accent_format', 'partner_sites_slug_format', 'partner_sites_slug_not_reserved',
    ]);
  });
  it.each(['#FFFFFF', '#fff', 'red', '0c5bd2', '#0c5bd2;x'])('CHECK rejects accent %j', async (c) => {
    await rejectsWith(ins(db, `'default', NULL, '${c}'`), PG.check);
  });
});
