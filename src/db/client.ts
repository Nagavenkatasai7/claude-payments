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
    const pool = new Pool({ connectionString: env.databaseUrl });
    cached = drizzle(pool, { schema });
  }
  return cached;
}

export type Db = ReturnType<typeof getDb>;
// The transaction handle passed to db.transaction(async (tx) => …) callbacks.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
// Anything repos accept: the root handle or an in-flight transaction.
export type DbOrTx = Db | Tx;
