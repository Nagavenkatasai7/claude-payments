import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { env } from '@/lib/env';
import * as schema from './schema';

// db/client — the cached Drizzle handle over Neon's serverless WebSocket Pool.
//
// WHY neon-serverless (WebSocket), not neon-http: the money paths need real
// interactive transactions (multi-statement BEGIN…COMMIT with the idempotency
// insert + transfer insert + outbox rows together) and the outbox worker needs
// SELECT … FOR UPDATE SKIP LOCKED — neither works over the stateless http
// driver. Vercel Fluid Compute reuses the warm Pool across invocations, so the
// connection cost amortizes the same way the Redis client does.

neonConfig.webSocketConstructor = ws; // Node runtime needs an explicit WS impl

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!cached) {
    // Program-Fix 27 (neon-12): explicit sizing instead of the node-postgres
    // defaults (max 10, idle 30 s, NO acquire timeout). Names/types:
    // @neondatabase/serverless index.d.ts:287 + :1035-1043 (v1.1.0).
    //  - max 5 per instance: no flow holds two connections at once (the mint
    //    hands its callback tx-bound ops only, store.ts mintUnderSenderLock;
    //    the worker drains its batch one row at a time), so 5 is 5 concurrent
    //    DB-bound requests per warm instance, the rest queue.
    //  - connectionTimeoutMillis 5 s: a saturated pool fails a request in 5 s
    //    (same bound as the mint's lock_timeout) rather than hanging it.
    //  - idle 10 s frees connections so Neon can scale to zero; maxUses 500
    //    recycles long-lived sockets on warm Fluid instances.
    const pool = new Pool({
      connectionString: env.databaseUrl,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 500,
    });
    cached = drizzle(pool, { schema });
  }
  return cached;
}

export type Db = ReturnType<typeof getDb>;
// The transaction handle passed to db.transaction(async (tx) => …) callbacks.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
// Anything repos accept: the root handle or an in-flight transaction.
export type DbOrTx = Db | Tx;
