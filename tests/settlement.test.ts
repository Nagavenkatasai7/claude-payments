import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginSettlement } from '@/lib/settlement';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';

// beginSettlement — THE transactional money path (Stage 2c). The paid flip and
// every external effect commit in ONE transaction, each effect dedupe-keyed.

function fixture(): Transfer {
  return {
    id: 'st_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-09T00:00:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};
const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };

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

describe('beginSettlement — webhook-driven rail (http/simulator)', () => {
  it('ONE transaction: flips paid + enqueues the stage-1 message AND the signed instruct', async () => {
    await store.saveTransfer(fixture());
    const r = await beginSettlement(db, fixture(), SIMULATOR);

    expect(r).toEqual({ kind: 'started', webhookDriven: true });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('paid');
    expect(after?.paidAt).toBeTruthy();
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' },
      { kind: 'settlement.instruct', dedupe_key: 'instruct:st_t1' },
    ]);
    // Webhook-driven: the providerRef comes from the rail's ack, not pre-set.
    expect(after?.paymentProviderRef).toBeUndefined();
  });

  it("a double submit is an idempotent no-op: 'already', NO duplicate effects", async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), SIMULATOR);
    const second = await beginSettlement(db, fixture(), SIMULATOR);

    expect(second).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(2); // still exactly stage1 + instruct
  });

  it("a transfer past awaiting_payment (delivered) is 'already' — never re-flipped", async () => {
    await store.saveTransfer({ ...fixture(), status: 'delivered' });
    const r = await beginSettlement(db, fixture(), SIMULATOR);
    expect(r).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('delivered');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('beginSettlement — mock rail (default partner sandbox)', () => {
  it('flips paid + enqueues the DELAYED mock settle + sets the deterministic providerRef', async () => {
    await store.saveTransfer(fixture());
    const r = await beginSettlement(db, fixture(), MOCK);

    expect(r).toEqual({ kind: 'started', webhookDriven: false });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('paid');
    expect(after?.paymentProviderRef).toBe('mock-st_t1');
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' },
      { kind: 'mock.settle', dedupe_key: 'mocksettle:st_t1' },
    ]);
    // The settle row is DELAYED (the sandbox's 2-minute lag).
    const due = await db.execute(
      sql`SELECT next_attempt_at > now() + interval '60 seconds' AS delayed FROM outbox WHERE kind = 'mock.settle'`,
    );
    expect((due as unknown as { rows: Array<{ delayed: boolean }> }).rows[0].delayed).toBe(true);
  });
});
