import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import type { InstructHeldReason } from '@/lib/instruct-gates';

// Fix pack 5 T6 (P9): both stuck-paid sweeps skip a row a later instruct gate
// holds on purpose (mockfund / fundmode / travelrule; the predicates arrive in
// T14 and T23). This file stands the predicate in with a hoisted value; the
// REAL alertStuckHeld runs. With null, both sweeps behave as before.
const held = vi.hoisted(() => ({ value: null as InstructHeldReason | null }));
vi.mock('@/lib/instruct-gates', async (orig) => ({
  ...(await orig<typeof import('@/lib/instruct-gates')>()),
  instructHeldOnPurpose: async () => held.value,
}));

import { reconcileSweep } from '@/lib/reconcile';
import { escalateStuckPaid } from '@/lib/stale-money';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'hs_t1';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), paidAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const alertKeys = async () =>
  (await rows<{ k: string }>(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)).map((r) => r.k);
const instructKeys = async () =>
  (await rows<{ k: string }>(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'settlement.instruct' ORDER BY id`)).map((r) => r.k);
const auditCount = async (action: string) =>
  Number((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}`))[0].n);

async function instructRow(status: string) {
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
  await db.execute(sql`UPDATE outbox SET status = ${status} WHERE dedupe_key = ${`instruct:${ID}`}`);
}

beforeEach(async () => {
  held.value = null;
  db = await freshDb();
  await seedPartner(db, 'acme');
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
    kyc: {},
    payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
    whatsapp: {},
  });
  await createStore(fakeRedis(), db).saveTransfer(fixture());
  // Stuck for 2 hours: past reconcile's 15 minutes and stale-money's first (1 h) rung.
  await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '2 hours' WHERE id = ${ID}`);
});

describe('stuck-paid sweeps skip a row held on purpose (P9)', () => {
  it("held = 'mockfund', instruct row DONE: reconcileSweep writes no reinstruct, no recon:, no sanctions.screen audit, and ONE mockfund:stuck:<id>", async () => {
    held.value = 'mockfund';
    await instructRow('done');
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
    expect(await alertKeys()).toEqual([`mockfund:stuck:${ID}`]);
    expect(await auditCount('sanctions.screen')).toBe(0);
    await reconcileSweep(db);
    expect(await alertKeys()).toEqual([`mockfund:stuck:${ID}`]);
  });

  it("held = 'mockfund', instruct row DONE: escalateStuckPaid writes no rung and no transfer.stuck_escalated audit; the stuck key is shared with reconcile", async () => {
    held.value = 'mockfund';
    await instructRow('done');
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([`mockfund:stuck:${ID}`]);
    await reconcileSweep(db);
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([`mockfund:stuck:${ID}`]);
    expect(await auditCount('transfer.stuck_escalated')).toBe(0);
  });

  it('held, instruct row PENDING (the worker owns it): no stuck alert from either sweep, no reinstruct, no rung', async () => {
    held.value = 'fundmode';
    await instructRow('pending');
    expect((await reconcileSweep(db)).reinstructed).toBe(0);
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([]);
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
    expect(await auditCount('transfer.stuck_escalated')).toBe(0);
  });

  it('held = null: reconcileSweep re-instructs once and alerts recon: (unchanged)', async () => {
    await instructRow('done');
    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(1);
    expect(await instructKeys()).toEqual([`instruct:${ID}`, `reinstruct:${ID}`]);
    expect(await alertKeys()).toContain(`recon:${ID}`);
    expect((await alertKeys()).filter((k) => k.includes(':stuck:'))).toEqual([]);
  });

  it('held = null: escalateStuckPaid raises the 1h rung with its audit row (unchanged)', async () => {
    expect(await escalateStuckPaid(db)).toBe(1);
    expect(await alertKeys()).toEqual([`recon:${ID}:1h`]);
    expect(await auditCount('transfer.stuck_escalated')).toBe(1);
  });
});
