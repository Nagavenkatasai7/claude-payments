import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// Fix pack 5 T7 (R40, contract P2): rail_messages is append-only IN THE
// DATABASE (drizzle/0039, function rail_messages_append_only). DELETE is
// refused; an UPDATE passes only when body_enc alone changes (the key-rotation
// re-seal). The to_jsonb comparison covers columns a LATER migration adds. No
// TRUNCATE trigger: freshDb() truncates between tests. These run on PGlite
// migrated from the real ./drizzle chain.

const APPEND_ONLY = /rail_messages is append-only/;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const PLAIN = '{"type":"settlement.instruct","transfer_id":"t_1"}';
const ID = '00000000-0000-4000-8000-0000000000a1';
type Rows<T> = { rows: T[] };
const exec = (db: Db, q: string) => db.execute(sql.raw(q));
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await exec(db, q)) as unknown as Rows<T>).rows;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await exec(db, `INSERT INTO rail_messages (id, partner_id, rail_partner_id, transfer_id, direction, kind, body_enc, body_sha256, signature_header)
    VALUES ('${ID}', 'default', 'default', 't_1', 1, 'settle', 'v2.k0.sealed-a', '${sha(PLAIN)}', 't=1,v2=abc')`);
});

/** The error text of a rejected statement, including drizzle's wrapped cause. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return `${String((e as Error).message)} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

const all = () => rows<Record<string, unknown>>(db, 'SELECT * FROM rail_messages ORDER BY id');

describe('rail_messages append-only trigger (fix pack 5, migration 0039)', () => {
  it('INSERT works', async () => {
    await exec(db, `INSERT INTO rail_messages (id, partner_id, rail_partner_id, transfer_id, direction, kind, body_enc, body_sha256)
      VALUES ('00000000-0000-4000-8000-0000000000a2', NULL, 'default', 't_x', 2, 'callback', 'v2.k0.sealed-b', '${sha('x')}')`);
    expect((await all()).map((r) => r.kind)).toEqual(['settle', 'callback']);
  });

  it('DELETE is refused and the row survives', async () => {
    expect(await rejection(exec(db, 'DELETE FROM rail_messages'))).toMatch(APPEND_ONLY);
    expect(await rejection(exec(db, `DELETE FROM rail_messages WHERE id = '${ID}'`))).toMatch(APPEND_ONLY);
    expect(await all()).toHaveLength(1);
  });

  it('an UPDATE of any one non-body column is refused', async () => {
    const before = await all();
    const sets = [
      `id = '00000000-0000-4000-8000-0000000000ff'`,
      'partner_id = NULL',
      'rail_partner_id = NULL',
      `transfer_id = 't_2'`,
      'direction = 2',
      `kind = 'reverse'`,
      `body_sha256 = '${sha('other')}'`,
      `signature_header = 't=2,v2=def'`,
      `created_at = created_at - interval '1 minute'`,
    ];
    for (const set of sets) {
      expect(await rejection(exec(db, `UPDATE rail_messages SET ${set}`)), set).toMatch(APPEND_ONLY);
    }
    expect(await all()).toEqual(before);
  });

  it('an UPDATE that sets body_enc to the same value is refused (no-op re-seal)', async () => {
    expect(await rejection(exec(db, `UPDATE rail_messages SET body_enc = 'v2.k0.sealed-a'`))).toMatch(APPEND_ONLY);
    expect(await rejection(exec(db, 'UPDATE rail_messages SET body_enc = body_enc'))).toMatch(APPEND_ONLY);
  });

  it('an UPDATE that changes body_enc AND another column is refused', async () => {
    const before = await all();
    expect(await rejection(exec(db, `UPDATE rail_messages SET body_enc = 'v2.k1.sealed-b', transfer_id = 't_2'`))).toMatch(APPEND_ONLY);
    expect(await rejection(exec(db, `UPDATE rail_messages SET body_enc = 'v2.k1.sealed-b', body_sha256 = '${sha('swap')}'`))).toMatch(APPEND_ONLY);
    expect(await all()).toEqual(before);
  });

  it('a body_enc-only change passes (the key-rotation re-seal) and body_sha256 is unchanged', async () => {
    await exec(db, `UPDATE rail_messages SET body_enc = 'v2.k1.sealed-a' WHERE id = '${ID}'`);
    const [r] = await rows<{ body_enc: string; body_sha256: string }>(db, 'SELECT body_enc, body_sha256 FROM rail_messages');
    expect(r.body_enc).toBe('v2.k1.sealed-a');
    expect(r.body_sha256).toBe(sha(PLAIN));
    // A swapped body is detectable: the immutable hash does not match another plaintext.
    expect(r.body_sha256).not.toBe(sha('{"type":"settlement.instruct","transfer_id":"t_evil"}'));
  });

  it('TRUNCATE still works (freshDb depends on it)', async () => {
    await exec(db, 'TRUNCATE rail_messages');
    expect(await all()).toHaveLength(0);
  });

  it('a column added after 0039 cannot be updated (the to_jsonb rule)', async () => {
    // freshDb shares one migrated PGlite per file, so the column is dropped in finally.
    await exec(db, 'ALTER TABLE rail_messages ADD COLUMN x text');
    try {
      expect(await rejection(exec(db, `UPDATE rail_messages SET x = 'y'`))).toMatch(APPEND_ONLY);
      // ...and a re-seal that also touches it is refused too.
      expect(await rejection(exec(db, `UPDATE rail_messages SET x = 'y', body_enc = 'v2.k1.sealed-a'`))).toMatch(APPEND_ONLY);
      // A body-only re-seal still passes with the extra column present.
      await exec(db, `UPDATE rail_messages SET body_enc = 'v2.k1.sealed-a'`);
    } finally {
      await exec(db, 'ALTER TABLE rail_messages DROP COLUMN x');
    }
  });
});
