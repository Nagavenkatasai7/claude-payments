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
// ONE PGlite instance per worker process, stored as a module-level variable.
// vitest.config.ts sets isolate:false in the forks pool so the module registry
// is NOT cleared between test files in the same worker — _pgliteDb is allocated
// once per worker and reused across every file that worker handles.
//
// With isolate:true (default), vitest re-imports every module per file, which
// creates a fresh PGlite WASM instance each time. Each instance holds ~670 MB
// of V8 heap in ArrayBuffer backing stores that cannot be reclaimed mid-run
// (vitest keeps test-function closures alive for retry/reporting). On a 7 GB
// runner Node.js auto-sizes the heap to ~4 GB, so 6 instances × ~670 MB = OOM.
// With isolate:false: 4 workers × ~670 MB = ~2.7 GB — safe.
// The engine is freed when the OS reclaims the worker process after all its
// files complete; no explicit close() is needed.

// Module-level singleton — survives for the worker's entire lifetime because
// isolate:false keeps this module loaded (not re-imported) between test files.
let _pgliteDb: Promise<ReturnType<typeof drizzle<typeof schema>>> | undefined;

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
