import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { reconcileSweep, getOpsSnapshot } from '@/lib/reconcile';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// reconcileSweep — the Stage-2d safety net. Stuck/stale money states surface as
// EXACTLY-ONCE deduped outbox effects, no matter how often the sweep runs.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rc_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-01T00:00:00.000Z', paidAt: '2026-06-01T00:01:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
});

describe('reconcileSweep — stuck paid (webhook-driven rail)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
  });

  it('re-instructs ONCE + alerts ONCE, and re-running the sweep adds NOTHING', async () => {
    await store.saveTransfer(fixture());

    const first = await reconcileSweep(db);
    expect(first).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0 });
    expect(await outboxRows()).toEqual([
      { kind: 'settlement.instruct', dedupe_key: 'reinstruct:rc_t1' },
      { kind: 'ops.alert', dedupe_key: 'recon:rc_t1' },
    ]);

    // The sweep runs on EVERY worker poke — dedupe keys make that safe.
    const second = await reconcileSweep(db);
    expect(second.stuckPaid).toBe(1);
    expect(second.reinstructed).toBe(0); // dedupe blocked the duplicate
    expect(await outboxRows()).toHaveLength(2);
  });

  it('a recently-paid transfer is NOT stuck (no effects)', async () => {
    await store.saveTransfer(fixture({ paidAt: new Date().toISOString() }));
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0 });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('reconcileSweep — stuck paid (mock rail)', () => {
  it('alerts but NEVER re-instructs (there is no rail to instruct)', async () => {
    await store.saveTransfer(fixture()); // 'acme' has no integrations row ⇒ mock
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 0, staleReviews: 0 });
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'recon:rc_t1' }]);
  });
});

describe('reconcileSweep — stuck paid (ROUTED via settlementPartnerId)', () => {
  it("classifies + re-instructs via the SETTLEMENT partner's rail (owner is mock)", async () => {
    // Owner 'acme' has NO integrations row ⇒ mock. The route is railp's rail —
    // without routing this transfer is misclassified and never re-instructed.
    await seedPartner(db, 'railp');
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(fixture({ settlementPartnerId: 'railp' }));

    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0 });
    expect(await outboxRows()).toEqual([
      { kind: 'settlement.instruct', dedupe_key: 'reinstruct:rc_t1' },
      { kind: 'ops.alert', dedupe_key: 'recon:rc_t1' },
    ]);
    // The alert points ops at the SETTLEMENT partner (whose rail owes the
    // callback), not just the brand owner.
    const alert = (await db.execute(
      sql`SELECT payload->>'message' AS message FROM outbox WHERE kind = 'ops.alert'`,
    )) as unknown as { rows: Array<{ message: string }> };
    expect(alert.rows[0].message).toContain('settles via railp');
    expect(alert.rows[0].message).toContain('Re-instructed the partner rail once.');
  });
});

describe('reconcileSweep — stale compliance reviews', () => {
  it('alerts exactly once for an in_review transfer older than 24h', async () => {
    await store.saveTransfer(fixture({ id: 'rc_rev1', status: 'in_review' }));
    const r = await reconcileSweep(db);
    expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 1 });
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'review:rc_rev1' }]);
    await reconcileSweep(db);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe('getOpsSnapshot', () => {
  it('returns the four ops surfaces (pending, dead, stuck, stale)', async () => {
    await store.saveTransfer(fixture());
    await store.saveTransfer(fixture({ id: 'rc_rev1', status: 'in_review' }));
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('whatsapp.text', { to: 'x', body: 'y' });
    await db.execute(sql`INSERT INTO outbox (kind, payload, status) VALUES ('whatsapp.text', '{}'::jsonb, 'dead')`);

    const snap = await getOpsSnapshot(db);
    expect(snap.pendingOutbox).toBe(1);
    expect(snap.deadLetters).toHaveLength(1);
    expect(snap.stuckPaid.map((t) => t.id)).toEqual(['rc_t1']);
    expect(snap.staleReviews.map((t) => t.id)).toEqual(['rc_rev1']);
  });
});
