import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { afterAll } from 'vitest';
import * as schema from '@/db/schema';
import type { Db } from '@/db/client';

// helpers-db — REAL Postgres in-process (PGlite) for repo/outbox/transaction
// tests. A hand-rolled fake cannot honor UNIQUE(partner_id,key), FOR UPDATE
// SKIP LOCKED, or the rank-guarded atomic UPDATE — which are exactly the
// behaviors under test, so we run the genuine engine.
//
// vitest.config.ts uses pool:'threads' with isolate:true (default), so each
// test file runs in its own worker_thread with a fresh module registry and a
// separate V8 isolate. This module-level _pgliteDb singleton allocates ONE
// PGlite WASM engine per thread — preventing repeated migration in a file's
// beforeEach calls. maxThreads:1 means at most 1 PGlite instance exists at a
// time.
//
// Memory: PGlite allocates a ~670 MB WASM ArrayBuffer. With 169 sequential
// test files (all in the same process via worker_threads), un-reclaimed WASM
// from previous workers accumulates in the process RSS. The afterAll below
// calls client.close() so the WASM ArrayBuffer is released and GC-eligible
// BEFORE the worker thread exits — reducing RSS overlap between consecutive
// workers and keeping total process RSS within the 7 GB CI runner limit.

let _pgliteDb: Promise<ReturnType<typeof drizzle<typeof schema>>> | undefined;
let _pgliteClient: PGlite | undefined;

afterAll(async () => {
  if (_pgliteClient) {
    await _pgliteClient.close();
    _pgliteClient = undefined;
    _pgliteDb = undefined;
  }
});

const ALL_TABLES = [
  'outbox',
  'idempotency_keys',
  'audit_events',
  'partner_rates',
  'ticket_messages',
  'tickets',
  'transfers',
  'schedules',
  'beneficiaries',
  'recipients',
  'kyc_cases',
  'corridor_requests',
  'api_keys',
  'partner_integrations',
  'customers',
  'partners',
].join(', ');

export async function freshDb(): Promise<Db> {
  if (!_pgliteDb) {
    _pgliteDb = (async () => {
      const client = new PGlite();
      _pgliteClient = client;
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: './drizzle' });
      return db;
    })();
  }
  const db = await _pgliteDb;
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES} RESTART IDENTITY CASCADE`));
  await db.execute(
    sql.raw(
      // Mirror prod post-migration-0006: the default tenant is any-to-any
      // (serves every unambiguous source country), so resolveSendCurrency
      // auto-detects the sender's currency instead of collapsing to USD.
      `INSERT INTO partners (id, name, status, countries, kyc_mode)
       VALUES ('default', 'SmartRemit Default', 'active', '["US","GB","AE","SG","AU","NZ","IN"]'::jsonb, 'ours')
       ON CONFLICT (id) DO NOTHING`,
    ),
  );
  return db as unknown as Db;
}

/** Insert an extra partner row for multi-tenant tests. */
export async function seedPartner(db: Db, id: string, name = id): Promise<void> {
  await db.execute(
    sql.raw(
      `INSERT INTO partners (id, name, status, countries, kyc_mode)
       VALUES ('${id}', '${name}', 'active', '["US"]'::jsonb, 'ours')
       ON CONFLICT (id) DO NOTHING`,
    ),
  );
}
