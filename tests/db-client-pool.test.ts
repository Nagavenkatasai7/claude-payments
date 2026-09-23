import { describe, it, expect, vi } from 'vitest';

// Program-Fix 27 (neon-12): the ledger Pool carries explicit size and timeout
// options instead of the node-postgres defaults (max 10, idle 30 s, and no
// acquire timeout, so a saturated pool waited forever). Option names and types:
// node_modules/@neondatabase/serverless/index.d.ts:287 (connectionTimeoutMillis)
// and :1035-1043 (PoolConfig: max, idleTimeoutMillis, maxUses), v1.1.0.

const Pool = vi.hoisted(() => vi.fn(function PoolMock() {}));
vi.mock('@neondatabase/serverless', () => ({ Pool, neonConfig: {} }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('@/lib/env', () => ({ env: { databaseUrl: 'postgres://pool-test.invalid/db' } }));

import { getDb } from '@/db/client';

describe('db/client Pool options (Program-Fix 27, neon-12)', () => {
  it('builds ONE Pool with max 5, idle 10 s, acquire timeout 5 s and maxUses 500', () => {
    getDb();
    getDb(); // cached: the second call reuses the Pool
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({
      connectionString: 'postgres://pool-test.invalid/db',
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 500,
    });
  });
});
