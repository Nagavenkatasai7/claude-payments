import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// Partner-Demo R3b (migration 0025): the conversation_messages table exists
// with the agreed shape after ./drizzle applies from scratch on PGlite. Raw SQL
// only — the writer PR owns the column driver mapping (bytea ↔ Buffer).

type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> =>
  ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;

const THREAD_KEY_HEX = 'ab'.repeat(32); // a 32-byte HMAC stand-in

describe('conversation_messages table (migration 0025)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('has the agreed columns, types and nullability', async () => {
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      db,
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'conversation_messages'
        ORDER BY ordinal_position`,
    );
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['partner_id', 'text', 'NO'],
      ['thread_key', 'bytea', 'NO'],
      ['channel', 'smallint', 'NO'],
      ['direction', 'smallint', 'NO'],
      ['body_enc', 'text', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
    ]);
    // id has NO default: the writer supplies deterministic ids (ON CONFLICT dedupe).
    expect(cols.find((c) => c.column_name === 'id')?.column_default).toBeNull();
    expect(cols.find((c) => c.column_name === 'created_at')?.column_default).toMatch(/now\(\)/);
  });

  it('has the (partner_id, thread_key, created_at) index and the primary key', async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(
      db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'conversation_messages' ORDER BY indexname`,
    );
    const thread = idx.find((i) => i.indexname === 'conversation_messages_thread');
    expect(thread?.indexdef).toMatch(/\(partner_id, thread_key, created_at\)/);
    expect(idx.some((i) => i.indexname === 'conversation_messages_pkey' && /\(id\)/.test(i.indexdef))).toBe(true);
  });

  it('accepts a row for an existing partner and rejects an unknown partner (FK to partners)', async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO conversation_messages (id, partner_id, thread_key, channel, direction, body_enc)
         VALUES ('00000000-0000-4000-8000-000000000001', 'default', decode('${THREAD_KEY_HEX}', 'hex'), 1, 1, 'v1:sealed')`,
      ),
    );
    const got = await rows<{ n: number; len: number }>(
      db,
      `SELECT count(*)::int AS n, max(octet_length(thread_key))::int AS len FROM conversation_messages`,
    );
    expect(got[0]).toEqual({ n: 1, len: 32 });

    await expect(
      db.execute(
        sql.raw(
          `INSERT INTO conversation_messages (id, partner_id, thread_key, channel, direction, body_enc)
           VALUES ('00000000-0000-4000-8000-000000000002', 'no-such-partner', decode('${THREAD_KEY_HEX}', 'hex'), 1, 1, 'v1:sealed')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('rejects a row with no id (no silent random id)', async () => {
    await expect(
      db.execute(
        sql.raw(
          `INSERT INTO conversation_messages (partner_id, thread_key, channel, direction, body_enc)
           VALUES ('default', decode('${THREAD_KEY_HEX}', 'hex'), 1, 1, 'v1:sealed')`,
        ),
      ),
    ).rejects.toThrow();
  });
});
