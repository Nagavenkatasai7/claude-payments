import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_1',
    phone: '15551230000',
    amountUsd: 200,
    feeUsd: 1.99,
    totalChargeUsd: 201.99,
    fxRate: 85.2,
    amountInr: 17040,
    recipientName: 'Anita',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-06-09T10:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 1.99,
    totalChargeSource: 201.99,
    ...over,
  };
}

let db: Db;
let repo: TransferRepo;
beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db, provider);
});

describe('transfer-repo: round-trip + encryption at rest', () => {
  it('saves and reads a transfer; numbers and dates survive the trip', async () => {
    await repo.saveTransfer(fixture());
    const t = await repo.getTransfer('tr_1', { decrypt: true });
    expect(t).toMatchObject({
      id: 'tr_1',
      amountUsd: 200,
      feeUsd: 1.99,
      fxRate: 85.2,
      amountInr: 17040,
      payoutDestination: '123456789012|HDFC0001234',
      status: 'awaiting_payment',
      createdAt: '2026-06-09T10:00:00.000Z',
    });
  });

  it('payout destination is ENCRYPTED at rest; default reads return only the masked last4', async () => {
    await repo.saveTransfer(fixture());
    // at rest: ciphertext, never the account
    const raw = await db.execute(
      `SELECT payout_destination_enc, payout_destination_last4 FROM transfers WHERE id = 'tr_1'`,
    );
    const row = (raw as unknown as { rows: Record<string, string>[] }).rows[0];
    expect(row.payout_destination_enc).not.toContain('123456789012');
    expect(row.payout_destination_enc.startsWith('v1.')).toBe(true);
    expect(row.payout_destination_last4).toBe('1234');
    // default (no-decrypt) read: masked
    const t = await repo.getTransfer('tr_1');
    expect(t!.payoutDestination).toBe('****1234');
  });

  it('an empty payout destination never touches crypto', async () => {
    await repo.saveTransfer(fixture({ id: 'tr_empty', payoutDestination: '' }));
    const t = await repo.getTransfer('tr_empty', { decrypt: true });
    expect(t!.payoutDestination).toBe('');
  });

  it('RMW GUARD: re-saving a MASKED read never clobbers the encrypted account at rest', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Anita K Sharma' }));
    // The classic read-modify-write: default (masked) read → mutate → save.
    const masked = (await repo.getTransfer('tr_1'))!;
    expect(masked.payoutDestination).toBe('****1234');
    await repo.saveTransfer({ ...masked, status: 'paid', paidAt: new Date().toISOString() });
    // Status advanced…
    const after = await repo.getTransfer('tr_1', { decrypt: true });
    expect(after!.status).toBe('paid');
    // …and the ciphertext (account + legal name) is untouched.
    expect(after!.payoutDestination).toBe('123456789012|HDFC0001234');
    expect(after!.recipientLegalName).toBe('Anita K Sharma');
  });
});

describe('transfer-repo: atomic webhook transition (rank-guarded UPDATE)', () => {
  it('advances forward only: awaiting→paid→delivered; duplicates and regressions no-op', async () => {
    await repo.saveTransfer(fixture());
    const paid = await repo.updateTransferFromWebhook('tr_1', 'paid');
    expect(paid!.status).toBe('paid');
    expect(paid!.paidAt).toBeTruthy();

    const dupPaid = await repo.updateTransferFromWebhook('tr_1', 'paid');
    expect(dupPaid).toBeNull(); // duplicate → no transition, no notifications

    const delivered = await repo.updateTransferFromWebhook('tr_1', 'delivered');
    expect(delivered!.status).toBe('delivered');
    expect(delivered!.deliveredAt).toBeTruthy();
    expect(delivered!.paidAt).toBe(paid!.paidAt); // paid_at never clobbered

    const regress = await repo.updateTransferFromWebhook('tr_1', 'paid');
    expect(regress).toBeNull(); // out-of-order replay ignored
  });

  it('terminal states never move (blocked / cancelled / in_review)', async () => {
    await repo.saveTransfer(fixture({ id: 'tr_blocked', status: 'blocked', complianceStatus: 'blocked' }));
    expect(await repo.updateTransferFromWebhook('tr_blocked', 'delivered')).toBeNull();
  });

  it('CONCURRENT funded + paid_out land consistently at delivered', async () => {
    await repo.saveTransfer(fixture());
    const [a, b] = await Promise.all([
      repo.updateTransferFromWebhook('tr_1', 'paid'),
      repo.updateTransferFromWebhook('tr_1', 'delivered'),
    ]);
    // Whatever the interleaving, the terminal state is delivered and at least
    // one call observed a real transition.
    expect((await repo.getTransfer('tr_1'))!.status).toBe('delivered');
    expect([a, b].some((r) => r !== null)).toBe(true);
  });
});

describe('transfer-repo: provider ref + reconciliation + scan-killers', () => {
  it('setProviderRef writes once and never clobbers', async () => {
    await repo.saveTransfer(fixture());
    await repo.setProviderRef('tr_1', 'rail-abc');
    await repo.setProviderRef('tr_1', 'rail-OTHER');
    expect((await repo.getTransfer('tr_1'))!.paymentProviderRef).toBe('rail-abc');
  });

  it('findStuckPaid surfaces only old paid transfers', async () => {
    await repo.saveTransfer(fixture({ id: 'tr_stuck', status: 'paid', paidAt: '2026-06-09T00:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 'tr_fresh', status: 'paid', paidAt: new Date().toISOString() }));
    await repo.saveTransfer(fixture({ id: 'tr_done', status: 'delivered', paidAt: '2026-06-09T00:00:00.000Z' }));
    const stuck = await repo.findStuckPaid(15);
    expect(stuck.map((t) => t.id)).toEqual(['tr_stuck']);
  });

  it('firstTransferAt + countByPhone answer without scanning the ledger', async () => {
    await repo.saveTransfer(fixture({ id: 'a', createdAt: '2026-06-01T00:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 'b', createdAt: '2026-06-05T00:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 'c', phone: '15559990000', createdAt: '2026-05-01T00:00:00.000Z' }));
    expect(await repo.firstTransferAt('15551230000')).toBe('2026-06-01T00:00:00.000Z');
    expect(await repo.firstTransferAt('19990000000')).toBeNull();
    expect(await repo.countByPhone('15551230000')).toBe(2);
  });
});

describe('transfer-repo: tenant scoping + keyset pagination', () => {
  it('getOwnedTransfer returns null for another partner (404-never-403 contract)', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'tr_acme', partnerId: 'acme' }));
    expect(await repo.getOwnedTransfer('acme', 'tr_acme')).not.toBeNull();
    expect(await repo.getOwnedTransfer('default', 'tr_acme')).toBeNull();
    expect(await repo.getOwnedTransfer('rival', 'tr_acme')).toBeNull();
  });

  it('listByPartner paginates with a stable keyset cursor', async () => {
    await seedPartner(db, 'acme');
    for (let i = 0; i < 5; i++) {
      await repo.saveTransfer(
        fixture({ id: `tr_${i}`, partnerId: 'acme', createdAt: `2026-06-0${i + 1}T00:00:00.000Z` }),
      );
    }
    const p1 = await repo.listByPartner('acme', { limit: 2 });
    expect(p1.items.map((t) => t.id)).toEqual(['tr_4', 'tr_3']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await repo.listByPartner('acme', { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((t) => t.id)).toEqual(['tr_2', 'tr_1']);
    const p3 = await repo.listByPartner('acme', { limit: 2, cursor: p2.nextCursor });
    expect(p3.items.map((t) => t.id)).toEqual(['tr_0']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('FK: a transfer for an unknown partner is rejected by the database itself', async () => {
    await expect(repo.saveTransfer(fixture({ id: 'tr_ghost', partnerId: 'nope' }))).rejects.toThrow();
  });
});

describe('transfer-repo: summary() — one-query dashboard aggregates + change stamp (Stage 4)', () => {
  it('aggregates today (eastern) vs all-time, per-status counts, needs-attention', async () => {
    const nowIso = new Date().toISOString();
    const oldIso = '2026-01-15T12:00:00.000Z';
    // Today: one delivered (fee 1.99) + one flagged awaiting (fresh — not abandoned).
    await repo.saveTransfer(fixture({ id: 's1', createdAt: nowIso, status: 'delivered', paidAt: nowIso, deliveredAt: nowIso }));
    await repo.saveTransfer(fixture({ id: 's2', createdAt: nowIso, complianceStatus: 'flagged' }));
    // Old: a paid row (fee counts all-time, not today) + an ancient abandoned awaiting.
    await repo.saveTransfer(fixture({ id: 's3', createdAt: oldIso, status: 'paid', paidAt: oldIso }));
    await repo.saveTransfer(fixture({ id: 's4', createdAt: oldIso }));

    const s = await repo.summary();
    expect(s.total).toBe(4);
    expect(s.countToday).toBe(2);
    expect(s.volumeToday).toBe(400);
    expect(s.commissionToday).toBe(1.99);       // only the delivered today
    expect(s.commissionAllTime).toBe(3.98);     // delivered today + paid old
    expect(s.flaggedToday).toBe(1);
    // flagged s2 + abandoned s4 (s1 delivered, s3 paid are fine)
    expect(s.needsAttention).toBe(2);
    expect(s.byStatus).toMatchObject({ delivered: 1, paid: 1, awaiting_payment: 2 });
    expect(s.latest).toBeTruthy();
  });

  it('is partner-scoped at the WHERE', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'p1', partnerId: 'acme' }));
    await repo.saveTransfer(fixture({ id: 'p2', partnerId: 'default' }));
    expect((await repo.summary('acme')).total).toBe(1);
    expect((await repo.summary()).total).toBe(2);
  });

  it('the stamp ingredients move on a pure status flip (paid → delivered)', async () => {
    const nowIso = new Date().toISOString();
    await repo.saveTransfer(fixture({ id: 'f1', status: 'paid', createdAt: nowIso, paidAt: nowIso }));
    const before = await repo.summary();
    await repo.updateTransferFromWebhook('f1', 'delivered');
    const after = await repo.summary();
    expect(after.byStatus.delivered).toBe(before.byStatus.delivered + 1);
    expect(after.byStatus.paid).toBe(before.byStatus.paid - 1);
  });

  it('an empty ledger summarizes to zeros, latest null', async () => {
    const s = await repo.summary();
    expect(s.total).toBe(0);
    expect(s.latest).toBeNull();
    expect(s.commissionAllTime).toBe(0);
  });
});
