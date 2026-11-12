import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend } from './helpers-db';
import type { Db } from '@/db/client';

// Fix pack 6 (P14): store.priorSends (root handle, draft time) and
// SenderLedgerOps.priorSends (in the mint lock, its OWN savepoint, null on
// failure, never throws).

const fault = vi.hoisted(() => ({ on: false }));
const logs = vi.hoisted(() => ({ errors: [] as Array<{ scope: string; fields: unknown }> }));

vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (handle: Parameters<typeof real.createTransferRepo>[0]) => {
      const repo = real.createTransferRepo(handle);
      return {
        ...repo,
        priorSends: async (...args: Parameters<typeof repo.priorSends>) => {
          if (fault.on) {
            // A REAL SQL error on the handle the store gave the repo.
            await handle.execute(sql`SELECT 1/0`);
          }
          return repo.priorSends(...args);
        },
      };
    },
  };
});

vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logError: (scope: string, _err: unknown, fields?: Record<string, unknown>) => {
      logs.errors.push({ scope, fields });
    },
  };
});

const DAY = 86_400_000;
const PHONE = '15550004444';
const RECIPIENT = '919000000043';
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  fault.on = false;
  logs.errors = [];
});
afterEach(() => vi.restoreAllMocks());

const ago = (ms: number) => new Date(Date.now() - ms);

describe('store.priorSends (root handle)', () => {
  it('store.priorSends(partnerId, phone, recipientPhone) reads live rows on the root handle', async () => {
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, environment: 'test', createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'delivered', createdAt: ago(2 * DAY) });
    const store = createStore(fakeRedis(), db);
    const txSpy = vi.spyOn(db, 'transaction');
    expect(await store.priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 2, toRecipient: 1 });
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('throws on a read error (the draft-time caller treats it as "fact unknown")', async () => {
    fault.on = true;
    await expect(createStore(fakeRedis(), db).priorSends('default', PHONE, RECIPIENT)).rejects.toThrow();
  });
});

describe('SenderLedgerOps.priorSends (in the lock)', () => {
  it('ops.priorSends inside mintUnderSenderLock sees the rows and honours before', async () => {
    const at = ago(DAY);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: at, id: 'tr_a' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: at, id: 'tr_b' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'awaiting_payment', recipientPhone: RECIPIENT, createdAt: ago(2 * DAY) });
    const store = createStore(fakeRedis(), db);
    const got = await store.mintUnderSenderLock('default', PHONE, async (ops) => ({
      all: await ops.priorSends(RECIPIENT),
      beforeB: await ops.priorSends(RECIPIENT, { at, id: 'tr_b' }),
      other: await ops.priorSends('919000000099'),
    }));
    expect(got).toEqual({
      all: { total: 2, toRecipient: 2 },
      beforeB: { total: 1, toRecipient: 1 },
      other: { total: 2, toRecipient: 0 },
    });
    expect(logs.errors).toEqual([]);
  });

  it("a failing read returns null, logs once by scope and partner id, and the lock's transaction stays usable", async () => {
    const store = createStore(fakeRedis(), db);
    fault.on = true;
    const stop = captureQueries();
    const r = await store.mintUnderSenderLock('default', PHONE, async (ops) => {
      const prior = await ops.priorSends('919000000043');
      await ops.recordAudit({ partnerId: 'default', actor: 'system:test', actorType: 'system', action: 'test.after_prior_sends', subjectId: 's_1' });
      return prior;
    });
    const log = stop();
    expect(r).toBeNull();
    expect(logs.errors).toEqual([{ scope: 'mint.prior_sends', fields: { partnerId: 'default' } }]);
    const sqls = log.map((q) => q.sql.toLowerCase());
    expect(sqls.some((s) => s.startsWith('savepoint'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('rollback to savepoint'))).toBe(true);
    const rows = await db.execute(sql`SELECT action FROM audit_events WHERE action = 'test.after_prior_sends'`);
    expect(rows.rows).toHaveLength(1);
  });

  it('the op never throws', async () => {
    const store = createStore(fakeRedis(), db);
    fault.on = true;
    await store.mintUnderSenderLock('default', PHONE, async (ops) => {
      await expect(ops.priorSends('x')).resolves.toBeNull();
    });
  });
});
