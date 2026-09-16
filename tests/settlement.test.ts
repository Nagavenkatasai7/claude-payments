import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginSettlement } from '@/lib/settlement';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
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

describe('transfer-repo — hold claim + ledger-gated paid claim (Phase 1 Task 3)', () => {
  it('markInReviewIfAwaiting: ONE guarded UPDATE flips awaiting_payment → in_review and sets paidAt', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const held = await createTransferRepo(db).markInReviewIfAwaiting('st_t1');
    // The RETURNING row IS the post-claim state: in_review with paidAt, in one statement —
    // there is no intermediate 'paid' state for anyone to observe.
    expect(held?.status).toBe('in_review');
    expect(held?.paidAt).toBeTruthy();
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
  });

  it('markInReviewIfAwaiting is a no-op (null) once the row is not awaiting_payment — never resurrects', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markInReviewIfAwaiting('st_t1')).not.toBeNull();
    expect(await repo.markInReviewIfAwaiting('st_t1')).toBeNull(); // already held
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled' });
    expect(await repo.markInReviewIfAwaiting('st_c1')).toBeNull();
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_p1', status: 'paid' });
    expect(await repo.markInReviewIfAwaiting('st_p1')).toBeNull();
    expect((await store.getTransfer('st_p1'))?.status).toBe('paid');
  });

  it('markPaidIfAwaiting REFUSES (null, row untouched) unless compliance_status is cleared — the ledger decides', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markPaidIfAwaiting('st_t1')).toBeNull();
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    await store.saveTransfer({ ...fixture(), id: 'st_b1', complianceStatus: 'blocked' });
    expect(await repo.markPaidIfAwaiting('st_b1')).toBeNull();
    expect((await store.getTransfer('st_b1'))?.status).toBe('awaiting_payment');
    // Regression: a cleared row still flips.
    await store.saveTransfer({ ...fixture(), id: 'st_ok' });
    expect((await repo.markPaidIfAwaiting('st_ok'))?.status).toBe('paid');
  });

  it('a BLOCKED row is never held and never released: markInReviewIfAwaiting and markPaidIfInReview both refuse it (sanctions-blocked money is structurally unreleasable, even if a future writer puts a blocked row in in_review)', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), id: 'st_bh', complianceStatus: 'blocked' });
    expect(await repo.markInReviewIfAwaiting('st_bh')).toBeNull();
    expect((await store.getTransfer('st_bh'))?.status).toBe('awaiting_payment');
    await store.saveTransfer({ ...fixture(), id: 'st_br', status: 'in_review', complianceStatus: 'blocked' });
    expect(await repo.markPaidIfInReview('st_br')).toBeNull();
    expect((await store.getTransfer('st_br'))?.status).toBe('in_review');
  });

  it("markPaidIfInReview: ONE guarded UPDATE flips in_review → paid with NO 'cleared' predicate (the staff release IS the decision — a released row stays flagged) but NEVER for a blocked row; a no-op from any other status", async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markPaidIfInReview('st_t1')).toBeNull(); // awaiting_payment is NOT releasable
    expect((await repo.markInReviewIfAwaiting('st_t1'))?.status).toBe('in_review');
    const paidAtHeld = (await store.getTransfer('st_t1'))?.paidAt;
    const released = await repo.markPaidIfInReview('st_t1');
    expect(released?.status).toBe('paid');
    expect(released?.complianceStatus).toBe('flagged'); // never rewritten
    expect(released?.paidAt).toBe(paidAtHeld);          // COALESCE — the charge time is kept
    expect(await repo.markPaidIfInReview('st_t1')).toBeNull(); // idempotent
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled' });
    expect(await repo.markPaidIfInReview('st_c1')).toBeNull();
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
  });
});
