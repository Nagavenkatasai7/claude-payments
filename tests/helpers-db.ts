import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Db } from '@/db/client';

// helpers-db — REAL Postgres in-process (PGlite) for repo/outbox/transaction
// tests. A hand-rolled fake cannot honor UNIQUE(partner_id,key), FOR UPDATE
// SKIP LOCKED, or the rank-guarded atomic UPDATE — which are exactly the
// behaviors under test, so we run the genuine engine.
//
// ONE PGlite instance per worker process, stored in `global` so it survives
// vitest's per-file module-registry reset (isolate:true in forks pool).
// Creating a new WASM engine per file accumulates ~670 MB/instance and cannot
// be reclaimed mid-run: vitest retains test-function closures that hold the
// freshDb→drizzle→PGlite→WASM reference chain live across module resets,
// blocking gc() from collecting the ArrayBuffer backing stores (confirmed by
// repeated OOM at exactly 4 GB after ~6 PGlite files per worker).
// With a single global engine: 4 workers × ~670 MB = ~2.7 GB — safe.
// The engine is freed when the OS reclaims the worker process after all its
// files complete; no explicit close() is needed.

declare global {
  // eslint-disable-next-line no-var
  var __pgliteDb: Promise<ReturnType<typeof drizzle<typeof schema>>> | undefined;
}

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
  if (!global.__pgliteDb) {
    global.__pgliteDb = (async () => {
      const client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: './drizzle' });
      return db;
    })();
  }
  const db = await global.__pgliteDb;
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
