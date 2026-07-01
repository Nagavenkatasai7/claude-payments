import { afterAll } from 'vitest';
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
// One PGlite instance per test file (module singleton reset on each fresh
// import). freshDb() truncates and re-seeds between tests in the same file.
//
// afterAll closes the client so PGlite.close() frees the WASM backing store
// before the module is discarded. Without this, the WASM ArrayBuffer from
// every file accumulates in the worker-process heap and hits V8's 4 GB limit.

let pgliteClient: PGlite | null = null;
let initPromise: Promise<ReturnType<typeof drizzle<typeof schema>>> | null = null;

async function initOnce() {
  pgliteClient = new PGlite();
  const db = drizzle(pgliteClient, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

afterAll(async () => {
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
    initPromise = null;
    // Force a synchronous GC cycle so V8 actually frees the WASM ArrayBuffer
    // backing store before the next file starts. Without this, V8's lazy GC
    // defers collection and multiple files' WASM memories pile up to 4+ GB.
    // Requires --expose-gc (set via NODE_OPTIONS in CI and locally).
    (global as Record<string, unknown>).gc?.();
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
  if (!initPromise) initPromise = initOnce();
  const db = await initPromise;
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
