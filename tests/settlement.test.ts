import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { HOLD_REPLY } from '@/lib/hold-replies';

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

// Program-Fix 28: the real audit repo with a switch that forces its insert to
// fail. Off by default, so every other case runs the real repo unchanged.
let failAudit = false;
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});

// Pack 2 review round 3 (M1): a sender screening stamp that commits right
// AFTER settleOrHold's unlocked flags read; the locked read inside the settle
// transaction is the one that decides.
const senderRace = vi.hoisted(() => ({ stampAfterPreRead: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  const { sql: q } = await import('drizzle-orm');
  return {
    ...real,
    readSenderScreeningFlags: async (...a: Parameters<typeof real.readSenderScreeningFlags>) => {
      const flags = await real.readSenderScreeningFlags(...a);
      if (senderRace.stampAfterPreRead && !a[3]?.forUpdate) {
        senderRace.stampAfterPreRead = false;
        await a[0].execute(q`UPDATE customers SET pep_hit = true, screening_flagged_at = now() WHERE partner_id = ${a[1]} AND phone = ${a[2]}`);
      }
      return flags;
    },
  };
});

async function auditRows(): Promise<Array<{ partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> }>> {
  const r = await db.execute(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Array<{ partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> }> }).rows;
}

async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  failAudit = false;
  senderRace.stampAfterPreRead = false;
});

describe('beginSettlement — webhook-driven rail (http/simulator)', { retry: 0 }, () => {
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

describe('beginSettlement — mock rail (default partner sandbox)', { retry: 0 }, () => {
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

describe('transfer-repo — hold claim + ledger-gated paid claim (Phase 1 Task 3)', { retry: 0 }, () => {
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

describe('stage-1 payloads never carry a secret (fix 11 / F49)', { retry: 0 }, () => {
  it('beginSettlement: the stage-1 payload is exactly { to, body, partnerId, category } — the OWNING partner, no creds/token', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), SIMULATOR);
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'category', 'partnerId', 'to']);
    expect(payload.category).toBe('essential'); // Program-Fix 49A: survives STOP
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

describe('beginSettlement — compliance gate (only cleared money reaches a rail)', { retry: 0 }, () => {
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

describe('beginHold — the transactional compliance hold', { retry: 0 }, () => {
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
    expect(body).toContain(HOLD_REPLY); // R30: the fixed hold text
    expect(String(body).toLowerCase()).not.toContain('review');
    expect(body).not.toContain('within 1 business day');
    expect(body).not.toContain('123456789012'); // PII: the destination never enters the payload
  });

  it('the held stage-1 payload names the OWNER partnerId and carries NO creds (same shape as the paid stage-1 — fix 11)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'category', 'partnerId', 'template', 'to']);
    expect(payload.category).toBe('essential'); // Program-Fix 49A: survives STOP
    // 2026-10-03: the held-notice template rides along, used only when Meta refuses
    // the plain text because the 24-hour window has closed. R30 review fix: it is
    // transfer_processing (the fixed hold text), never transfer_in_review.
    expect((payload.template as { name: string }).name).toBe('transfer_processing');
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

describe('settleOrHold — the ONE decision every settlement caller goes through', { retry: 0 }, () => {
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

describe('releaseHold — the staff release IS a settlement (in_review → paid + the rail effect, one transaction)', { retry: 0 }, () => {
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

describe('releaseHold — staff audit context (Program-Fix 28)', { retry: 0 }, () => {
  it('with an audit context: ONE transfer.release row, keyed on the OWNER partner, inside the release transaction', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const r = await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR, { actor: 'plat', reason: 'docs ok' });
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    expect(await auditRows()).toEqual([{
      partner_id: 'acme', actor: 'plat', action: 'transfer.release', subject_id: 'st_t1',
      meta: { previousStatus: 'in_review', newStatus: 'paid', reason: 'docs ok' },
    }]);
  });

  it("a null claim ('already') writes NO audit row", async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' }); // awaiting_payment, never held
    expect(await releaseHold(db, fixture(), SIMULATOR, { actor: 'plat', reason: null })).toEqual({ kind: 'already' });
    expect(await auditRows()).toHaveLength(0);
  });

  it('a failing audit insert rolls the release back: still in_review, only the hold\'s stage-1 row in the outbox', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    failAudit = true;
    await expect(releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR, { actor: 'plat', reason: null })).rejects.toThrow('audit insert failed');
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:st_t1']);
  });

  it('without an audit context: no audit row (existing callers unchanged)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR);
    expect(await auditRows()).toHaveLength(0);
  });
});

// ── Fix pack 2 T9 (R02): the settle-time live-list backstop. A real-money rail
// (http, env not 'test') settles only on a newest screen that is live and fresh;
// otherwise the transfer is HELD with LIST_UNAVAILABLE added. Nothing else changes.
import { LIST_UNAVAILABLE_REASON, LARGE_AMOUNT_REASON } from '@/lib/compliance-config';
import { captureQueries } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';

const HTTP: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'http',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};
const H = 3_600_000;

describe('settleOrHold — settle-time live-list backstop (fix pack 2 T9)', { retry: 0 }, () => {
  const live = (over: Partial<Transfer> = {}): Transfer => ({ ...fixture(), environment: 'live', ...over } as Transfer);

  it('http rail, cleared, newest evidence live and fresh -> started', async () => {
    await store.saveTransfer(live());
    await seedLiveEvidence(db, live(), { listFitness: 'not_live', at: new Date(Date.now() - 60_000) });
    await seedLiveEvidence(db, live());
    expect(await settleOrHold(db, live(), HTTP)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']);
  });

  it('evidence stale / mock (not_live) / absent -> held, LIST_UNAVAILABLE added, no settlement.instruct', async () => {
    const cases: Array<[string, ((t: Transfer) => Promise<unknown>) | null]> = [
      ['st_stale', (t) => seedLiveEvidence(db, t, { screenedAgoMs: 37 * H })],
      ['st_staleList', (t) => seedLiveEvidence(db, t, { listFitness: 'stale' })],
      ['st_mock', (t) => seedLiveEvidence(db, t, { listFitness: 'not_live' })],
      ['st_old', (t) => seedLiveEvidence(db, t, { listFitness: null })],
      ['st_none', null],
      // the newest row decides: a live screen followed by a mock-list re-screen
      ['st_newest', async (t) => {
        await seedLiveEvidence(db, t, { at: new Date(Date.now() - 60_000) });
        await seedLiveEvidence(db, t, { listFitness: 'not_live' });
      }],
    ];
    for (const [id, seed] of cases) {
      const t = live({ id });
      await store.saveTransfer(t);
      if (seed) await seed(t);
      expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
      const after = await store.getTransfer(id);
      expect(after?.status).toBe('in_review');
      expect(after?.complianceStatus).toBe('flagged');
      expect(after?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    }
    const keys = (await outboxRows()).map((r) => r.dedupe_key);
    expect(keys.filter((k) => k?.startsWith('instruct:'))).toEqual([]);
    expect(keys).toHaveLength(cases.length); // one held stage-1 each
  });

  it('flagged LARGE + not live -> held with [LARGE, LIST_UNAVAILABLE]', async () => {
    const t = live({ complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'not_live' });
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
  });

  it('the LEDGER reasons are kept, never the caller\'s stale copy, and never duplicated', async () => {
    await store.saveTransfer(live({ complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON] }));
    expect(await settleOrHold(db, live(), HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
  });

  it("simulator / mock / env 'test' -> unchanged, zero audit reads", async () => {
    const runs: Array<[string, Transfer, PartnerIntegrations]> = [
      ['st_sim', live({ id: 'st_sim' }), SIMULATOR],
      ['st_mockrail', live({ id: 'st_mockrail' }), MOCK],
      ['st_sandbox', live({ id: 'st_sandbox', environment: 'test' }), HTTP],
    ];
    for (const [id, t, integrations] of runs) {
      await store.saveTransfer(t);
      await seedLiveEvidence(db, t, { listFitness: 'not_live' }); // a mock-list screen
      const stop = captureQueries();
      const r = await settleOrHold(db, t, integrations);
      const qs = stop();
      expect(r.kind).toBe('started');
      expect(qs.filter((q) => q.sql.includes('audit_events'))).toEqual([]);
      expect((await store.getTransfer(id))?.complianceStatus).toBe('cleared');
    }
  });

  it('rail switched simulator -> http after a mock-list clear -> held', async () => {
    // Minted on a simulator rail: the mock list cleared it (not_live evidence).
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t, { listFitness: 'not_live' });
    // The rail partner switched to http before the settlement.
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1']);
  });

  it('a blocked transfer is still refused first (no read, no hold)', async () => {
    const t = live({ complianceStatus: 'blocked' });
    await store.saveTransfer(t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'refused', complianceStatus: 'blocked' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('beginHold — addReasons (fix pack 2 T9)', { retry: 0 }, () => {
  it('beginHold without opts unchanged: compliance status and reasons untouched', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    expect(await beginHold(db, { ...fixture(), complianceStatus: 'flagged' })).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
  });

  it('addReasons on a cleared row flags it with the reasons and holds it, in one transaction', async () => {
    await store.saveTransfer(fixture());
    expect(await beginHold(db, fixture(), { addReasons: [LIST_UNAVAILABLE_REASON] })).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
  });

  it("addReasons on a row no longer awaiting -> 'already', nothing written", async () => {
    await store.saveTransfer({ ...fixture(), status: 'paid' });
    expect(await beginHold(db, fixture(), { addReasons: [LIST_UNAVAILABLE_REASON] })).toEqual({ kind: 'already' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('paid');
    expect(after?.complianceStatus).toBe('cleared');
    expect(after?.complianceReasons).toEqual([]);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("addReasons on a blocked row -> 'already', never downgraded", async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'blocked', complianceReasons: ['x'] });
    expect(await beginHold(db, fixture(), { addReasons: [LIST_UNAVAILABLE_REASON] })).toEqual({ kind: 'already' });
    const after = await store.getTransfer('st_t1');
    expect(after?.complianceStatus).toBe('blocked');
    expect(after?.complianceReasons).toEqual(['x']);
  });
});

// ── Fix pack 2 T6 (R06): the sender screening hold at pay. On a real-money rail
// a not-blocked transfer whose SENDER (owning tenant) has an active screening
// hold is held with SENDER_SCREENING_REASON added — both branches (a cleared
// row and one already flagged LARGE / VELOCITY / EDD / AML).
import { SENDER_SCREENING_REASON } from '@/lib/compliance-config';
import { seedSender } from './helpers-db';

describe('settleOrHold — sender screening hold (fix pack 2 T6)', { retry: 0 }, () => {
  const live = (over: Partial<Transfer> = {}): Transfer => ({ ...fixture(), environment: 'live', ...over } as Transfer);
  const PHONE = fixture().phone;
  const flagNow = async () => {
    await seedSender(db, { partnerId: 'acme', phone: PHONE });
    await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${PHONE}`);
  };

  it('cleared + http + now flagged -> in_review, reason added, no settlement.instruct', async () => {
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    await flagNow();
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1']);
  });

  it('flagged LARGE + active sender hold at pay -> reasons gain SENDER_SCREENING', async () => {
    const t = live({ complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    await flagNow();
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, SENDER_SCREENING_REASON]);
  });

  it('stale list + active sender hold -> both reasons', async () => {
    const t = live();
    await store.saveTransfer(t);
    await flagNow();
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON, SENDER_SCREENING_REASON]);
  });

  it('a cleared hold settles; another tenant\'s flagged row for the same phone is never read', async () => {
    await seedPartner(db, 'other');
    await seedSender(db, { partnerId: 'other', phone: PHONE });
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'other' AND phone = ${PHONE}`);
    await seedSender(db, { partnerId: 'acme', phone: PHONE });
    await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = now() - interval '2 hours', screening_cleared_at = now() - interval '1 hour' WHERE partner_id = 'acme' AND phone = ${PHONE}`);
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
  });

  // Pack 2 review R1 (H2): the platform release re-checks the hold inside its transaction.
  it("releaseHold, platform, http, sender stamped: 'sender_hold', still in_review, nothing enqueued or audited", async () => {
    const t = live({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    await flagNow();
    expect(await releaseHold(db, t, HTTP, { actor: 'plat', reason: 'ok' })).toEqual({ kind: 'sender_hold' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('releaseHold, platform, simulator, sender stamped: released, no customers read (not real money)', async () => {
    const t = live({ status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await store.saveTransfer(t);
    await flagNow();
    const stop = captureQueries();
    const r = await releaseHold(db, t, SIMULATOR);
    const qs = stop();
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    expect(qs.filter((q) => q.sql.includes('"customers"') && q.sql.toLowerCase().includes('for update'))).toEqual([]);
  });

  it('simulator -> settles, no customers read', async () => {
    const t = live();
    await store.saveTransfer(t);
    await flagNow();
    const stop = captureQueries();
    const r = await settleOrHold(db, t, SIMULATOR);
    const qs = stop();
    expect(r.kind).toBe('started');
    expect(qs.filter((q) => q.sql.includes('"customers"'))).toEqual([]);
  });

  // Pack 2 review round 3 (M1): the window between the unlocked flags read and
  // the paid flip is closed on real money: the settle transaction locks the
  // transfer, then the customer row, and re-reads the flags.
  it('M1: http, a stamp commits after the unlocked read -> held (SENDER_SCREENING), no instruct, customers read FOR UPDATE in the settle', async () => {
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    await seedSender(db, { partnerId: 'acme', phone: PHONE });
    senderRace.stampAfterPreRead = true;
    const stop = captureQueries();
    const r = await settleOrHold(db, t, HTTP);
    const qs = stop();
    expect(senderRace.stampAfterPreRead).toBe(false); // the stamp landed
    expect(r).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    expect((await outboxRows()).map((r2) => r2.dedupe_key)).toEqual(['stage1:st_t1']);
    const lower = qs.map((q) => q.sql.toLowerCase());
    const tLock = lower.findIndex((q) => q.includes('"transfers"') && q.includes('for update'));
    const cLock = lower.findIndex((q) => q.includes('"customers"') && q.includes('for update'));
    expect(tLock).toBeGreaterThanOrEqual(0);
    expect(cLock).toBeGreaterThan(tLock); // transfer first, then customer
  });

  it('M1: http, no stamp -> started; the locked re-read runs and finds no hold', async () => {
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    await seedSender(db, { partnerId: 'acme', phone: PHONE });
    const stop = captureQueries();
    expect(await settleOrHold(db, t, HTTP)).toEqual({ kind: 'started', webhookDriven: true });
    const qs = stop();
    expect(qs.filter((q) => q.sql.includes('"customers"') && q.sql.toLowerCase().includes('for update'))).toHaveLength(1);
    expect((await outboxRows()).map((r2) => r2.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']);
  });

  it("M1: simulator / mock / env 'test' -> no customers read and no transfer lock in the settle", async () => {
    const runs: Array<[Transfer, PartnerIntegrations]> = [
      [live({ id: 'st_m1sim' }), SIMULATOR],
      [live({ id: 'st_m1mock' }), MOCK],
      [live({ id: 'st_m1test', environment: 'test' }), HTTP],
    ];
    await flagNow();
    for (const [t, integrations] of runs) {
      await store.saveTransfer(t);
      const stop = captureQueries();
      const r = await settleOrHold(db, t, integrations);
      const qs = stop();
      expect(r.kind).toBe('started');
      expect(qs.filter((q) => q.sql.includes('"customers"'))).toEqual([]);
      expect(qs.filter((q) => q.sql.toLowerCase().includes('for update'))).toEqual([]);
    }
  });

  it('flags read error -> throws, nothing paid', async () => {
    const t = live();
    await store.saveTransfer(t);
    await seedLiveEvidence(db, t);
    // The flags read fails (the table is unreadable); nothing else in the pay path reads it.
    await db.execute(sql`ALTER TABLE customers RENAME TO customers_gone`);
    try {
      await expect(settleOrHold(db, t, HTTP)).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE customers_gone RENAME TO customers`);
    }
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toEqual([]);
  });
});
