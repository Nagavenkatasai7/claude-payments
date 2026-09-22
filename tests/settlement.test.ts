import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginSettlement, beginHold, settleOrHold, releaseHold } from '@/lib/settlement';
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
    // Backdate the hold an hour: the release must RESTART the paid_at clock
    // (findStuckPaid keys on it — a kept hold-time paid_at would make the next
    // sweep re-instruct a freshly released transfer).
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '1 hour' WHERE id = 'st_t1'`);
    const paidAtHeld = (await store.getTransfer('st_t1'))!.paidAt!;
    const released = await repo.markPaidIfInReview('st_t1');
    expect(released?.status).toBe('paid');
    expect(released?.complianceStatus).toBe('flagged'); // never rewritten
    expect(Date.parse(released!.paidAt!)).toBeGreaterThan(Date.parse(paidAtHeld) + 30 * 60_000); // paid_at = release time
    expect(await repo.markPaidIfInReview('st_t1')).toBeNull(); // idempotent
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled' });
    expect(await repo.markPaidIfInReview('st_c1')).toBeNull();
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
  });
});

async function stage1Payload(id: string): Promise<Record<string, unknown>> {
  const r = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = ${'stage1:' + id}`);
  return (r as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
}

describe('stage-1 payloads never carry a secret (fix 11 / F49)', () => {
  it('beginSettlement: the stage-1 payload is exactly { to, body, partnerId } — the OWNING partner, no creds/token', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), SIMULATOR);
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'partnerId', 'to']);
    expect(JSON.stringify(payload)).not.toMatch(/creds|token/i);
  });

  it('a ROUTED transfer: the stage-1 row names transfer.partnerId (the brand), never settlementPartnerId (the rail)', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...fixture(), settlementPartnerId: 'railp' });
    await beginSettlement(db, { ...fixture(), settlementPartnerId: 'railp' }, SIMULATOR);
    expect((await stage1Payload('st_t1')).partnerId).toBe('acme');
  });

  it('dedupe keys are unchanged by the payload change (stage1:/mocksettle:)', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), MOCK);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1', 'mocksettle:st_t1']);
  });

  it('no settlement entry point accepts a creds argument any more (compile-time guard — tsc fails if one is re-added)', () => {
    // Never executed: exists so `tsc --noEmit` (CI + the Stop hook) reports an
    // unused @ts-expect-error the moment a 4th/3rd creds parameter returns.
    const neverRun = async () => {
      // @ts-expect-error beginSettlement takes exactly (db, transfer, integrations)
      await beginSettlement(db, fixture(), MOCK, { phoneNumberId: 'x', token: 'y' });
      // @ts-expect-error beginHold takes exactly (db, transfer)
      await beginHold(db, fixture(), { phoneNumberId: 'x', token: 'y' });
      // @ts-expect-error settleOrHold takes exactly (db, transfer, integrations)
      await settleOrHold(db, fixture(), MOCK, { phoneNumberId: 'x', token: 'y' });
    };
    expect(typeof neverRun).toBe('function');
  });
});

async function stage1Body(id: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT payload->>'body' AS body FROM outbox WHERE dedupe_key = ${'stage1:' + id}`);
  return (r as unknown as { rows: Array<{ body: string }> }).rows[0]?.body ?? null;
}

describe('beginSettlement — compliance gate (only cleared money reaches a rail)', () => {
  it('REFUSES a flagged transfer: status stays awaiting_payment, ZERO outbox rows (no stage1, no settlement.instruct)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginSettlement(db, { ...fixture(), complianceStatus: 'flagged' }, SIMULATOR);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'flagged' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('REFUSES a blocked transfer (defence in depth — callers 400/422 first)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'blocked' });
    const r = await beginSettlement(db, { ...fixture(), complianceStatus: 'blocked' }, MOCK);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'blocked' });
    expect(await outboxRows()).toHaveLength(0);
    expect((await store.getTransfer('st_t1'))?.paymentProviderRef).toBeUndefined();
  });

  it('the LEDGER decides, not the passed object: a stale "cleared" Transfer over a flagged row is refused', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginSettlement(db, fixture() /* claims cleared */, SIMULATOR);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'flagged' });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('beginHold — the transactional compliance hold', () => {
  it('ONE transaction: flips awaiting_payment → in_review, sets paidAt, enqueues exactly one stage1:<id> row and NO rail effect', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    expect(r).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.complianceStatus).toBe('flagged'); // the hold never rewrites compliance
    expect(after?.paymentProviderRef).toBeUndefined(); // no mock ref — no rail was touched
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
    const body = await stage1Body('st_t1');
    expect(body).toContain('quick review');
    expect(body).not.toContain('within ~10 minutes');
    expect(body).not.toContain('123456789012'); // PII: the destination never enters the payload
  });

  it('the held stage-1 payload names the OWNER partnerId and carries NO creds (same shape as the paid stage-1 — fix 11)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'partnerId', 'to']);
  });

  it("is idempotent: a second call returns { kind: 'already' } and enqueues nothing", async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const second = await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    expect(second).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("on a cancelled / already-paid transfer is a no-op ('already') — never resurrects the row", async () => {
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled', complianceStatus: 'flagged' });
    expect(await beginHold(db, { ...fixture(), id: 'st_c1', status: 'cancelled' })).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_p1', status: 'paid' });
    expect(await beginHold(db, { ...fixture(), id: 'st_p1', status: 'paid' })).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_p1'))?.status).toBe('paid');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('settleOrHold — the ONE decision every settlement caller goes through', () => {
  it('cleared → started (settlement, rail effect enqueued)', async () => {
    await store.saveTransfer(fixture());
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']);
  });

  it('flagged → held (in_review, held message, NO rail effect)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await settleOrHold(db, { ...fixture(), complianceStatus: 'flagged' }, SIMULATOR)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
  });

  it('blocked → refused, nothing enqueued, status untouched', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'blocked' });
    expect(await settleOrHold(db, { ...fixture(), complianceStatus: 'blocked' }, MOCK)).toEqual({ kind: 'refused', complianceStatus: 'blocked' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('stale in-memory "cleared" over a ledger-flagged row → held (DB truth wins, no instruct)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'held' });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1']);
  });

  it("not awaiting_payment → already (replay), nothing enqueued", async () => {
    await store.saveTransfer({ ...fixture(), status: 'delivered' });
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('releaseHold — the staff release IS a settlement (in_review → paid + the rail effect, one transaction)', () => {
  it('webhook-driven rail: flips in_review → paid, keeps complianceStatus flagged, restarts paidAt at the release, enqueues instruct:<id> and NO second stage-1 message', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '1 hour' WHERE id = 'st_t1'`);
    const held = (await store.getTransfer('st_t1'))!;
    const r = await releaseHold(db, held, SIMULATOR);
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('paid');
    expect(after?.complianceStatus).toBe('flagged'); // release never rewrites compliance
    expect(Date.parse(after!.paidAt!)).toBeGreaterThan(Date.parse(held.paidAt!) + 30 * 60_000); // clock restarts at release
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']); // stage1 deduped, the rail IS told
  });

  it('mock rail: the same delayed mocksettle:<id> effect + write-once mock providerRef beginSettlement uses', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const r = await releaseHold(db, (await store.getTransfer('st_t1'))!, MOCK);
    expect(r).toEqual({ kind: 'released', webhookDriven: false });
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:st_t1', 'mocksettle:st_t1']);
    expect((await store.getTransfer('st_t1'))?.paymentProviderRef).toBe('mock-st_t1');
  });

  it('is idempotent and never resurrects: a second release, or a release of a cancelled/awaiting row, is { kind: "already" } with nothing enqueued', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR);
    expect(await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR)).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(2);
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled', complianceStatus: 'flagged' });
    expect(await releaseHold(db, { ...fixture(), id: 'st_c1', status: 'cancelled' }, SIMULATOR)).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_a1', complianceStatus: 'flagged' }); // awaiting, never held
    expect(await releaseHold(db, { ...fixture(), id: 'st_a1' }, SIMULATOR)).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_a1'))?.status).toBe('awaiting_payment');
  });

  it('a released flagged transfer then completes exactly like a cleared one: the rail callback delivers it', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR);
    expect((await store.updateTransferFromWebhook('st_t1', 'delivered'))?.status).toBe('delivered');
  });
});
