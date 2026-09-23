import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo, createIdempotencyRepo } from '@/db/repos/aux-repos';
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
    expect(row.payout_destination_enc.startsWith('v2.k0.')).toBe(true); // Program-Fix 46B
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

  it('MONEY SAFETY: a paid transfer with a refund in progress does NOT flip to delivered', async () => {
    // A paid-out callback arriving while the transfer is being refunded must be a
    // safe no-op — otherwise the recipient is paid AND the sender refunded.
    for (const refundStatus of ['requested', 'pending', 'completed', 'failed'] as const) {
      const id = `tr_refund_${refundStatus}`;
      await repo.saveTransfer(
        fixture({ id, status: 'paid', paidAt: '2026-06-09T00:00:00.000Z', refundStatus }),
      );
      const res = await repo.updateTransferFromWebhook(id, 'delivered');
      expect(res).toBeNull(); // no transition, no recipient notification
      expect((await repo.getTransfer(id))!.status).toBe('paid'); // still paid, not delivered
    }
  });

  it('a normal paid transfer (refund none) still flips to delivered (regression)', async () => {
    await repo.saveTransfer(
      fixture({ id: 'tr_norefund', status: 'paid', paidAt: '2026-06-09T00:00:00.000Z', refundStatus: 'none' }),
    );
    const res = await repo.updateTransferFromWebhook('tr_norefund', 'delivered');
    expect(res!.status).toBe('delivered');
    expect((await repo.getTransfer('tr_norefund'))!.status).toBe('delivered');
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
    expect(await repo.firstTransferAt('default', '15551230000')).toBe('2026-06-01T00:00:00.000Z');
    expect(await repo.firstTransferAt('default', '19990000000')).toBeNull();
    expect(await repo.countByPhone('default', '15551230000')).toBe(2);
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

describe('transfer-repo: compliance views + velocity leaderboard (Stage 5e scan fixes)', () => {
  it('listByCompliance filters by compliance_status and partner, newest-first', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'c1', complianceStatus: 'flagged', createdAt: '2026-06-09T10:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 'c2', complianceStatus: 'flagged', partnerId: 'acme', createdAt: '2026-06-09T11:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 'c3', complianceStatus: 'blocked', status: 'blocked' }));

    const flagged = await repo.listByCompliance('flagged');
    expect(flagged.map((t) => t.id)).toEqual(['c2', 'c1']); // newest first
    expect((await repo.listByCompliance('flagged', { partnerId: 'acme' })).map((t) => t.id)).toEqual(['c2']);
    expect((await repo.listByCompliance('blocked')).map((t) => t.id)).toEqual(['c3']);
  });

  it('topVelocityToday counts only today (eastern), grouped by phone, partner-scoped', async () => {
    await seedPartner(db, 'acme');
    const nowIso = new Date().toISOString();
    await repo.saveTransfer(fixture({ id: 'v1', phone: '15551110000', createdAt: nowIso }));
    await repo.saveTransfer(fixture({ id: 'v2', phone: '15551110000', createdAt: nowIso }));
    await repo.saveTransfer(fixture({ id: 'v3', phone: '15552220000', createdAt: nowIso, partnerId: 'acme' }));
    await repo.saveTransfer(fixture({ id: 'v4', phone: '15553330000', createdAt: '2026-01-15T12:00:00.000Z' })); // old — excluded

    const top = await repo.topVelocityToday(10);
    expect(top[0]).toEqual({ phone: '15551110000', count: 2 });
    expect(top.find((r) => r.phone === '15553330000')).toBeUndefined();
    expect(await repo.topVelocityToday(10, 'acme')).toEqual([{ phone: '15552220000', count: 1 }]);
  });
});

describe('transfer-repo: cancelIfCancellable — atomic VOID of an unfunded draft (Phase 1 Task 5 / money-05)', () => {
  it('voids an UNCHARGED awaiting_payment row; RETURNING is the masked read; only status is written', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_await' }));
    const res = await repo.cancelIfCancellable('cc_await', 'default');
    expect(res?.status).toBe('cancelled');
    expect(res?.payoutDestination).toBe('****1234'); // masked, like every default read
    const after = await repo.getTransfer('cc_await', { decrypt: true });
    expect(after!.status).toBe('cancelled');
    expect(after!.payoutDestination).toBe('123456789012|HDFC0001234'); // column-targeted: ciphertext untouched
  });

  it('is TENANT-SCOPED: another tenant’s id is a no-op (null) and the row is untouched; its own tenant voids it', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'cc_tenant', partnerId: 'default' }));
    expect(await repo.cancelIfCancellable('cc_tenant', 'acme')).toBeNull();
    const untouched = await repo.getTransfer('cc_tenant', { decrypt: true });
    expect(untouched).toMatchObject({ status: 'awaiting_payment', partnerId: 'default', payoutDestination: '123456789012|HDFC0001234' });
    expect(untouched!.fundingRef ?? null).toBeNull();
    expect((await repo.cancelIfCancellable('cc_tenant', 'default'))?.status).toBe('cancelled'); // control: the right tenant still voids
  });

  it('returns null for an in_review hold, charged OR NOT: a hold leaves in_review only via Release or Reject (admin)', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_review', status: 'in_review', complianceStatus: 'flagged' }));
    await repo.saveTransfer(
      fixture({ id: 'cc_review_chg', status: 'in_review', complianceStatus: 'flagged', fundingRef: 'mockfund-cc_review_chg' }),
    );
    expect(await repo.cancelIfCancellable('cc_review', 'default')).toBeNull();
    expect(await repo.cancelIfCancellable('cc_review_chg', 'default')).toBeNull();
    expect((await repo.getTransfer('cc_review'))!.status).toBe('in_review');
    expect((await repo.getTransfer('cc_review_chg'))!.status).toBe('in_review');
  });

  it('returns null and moves NOTHING for paid / delivered / cancelled / blocked', async () => {
    const paidAt = new Date().toISOString();
    for (const status of ['paid', 'delivered', 'cancelled', 'blocked'] as const) {
      const id = `cc_${status}`;
      await repo.saveTransfer(
        fixture({
          id,
          status,
          ...(status === 'paid' || status === 'delivered' ? { paidAt } : {}),
          complianceStatus: status === 'blocked' ? 'blocked' : 'cleared',
        }),
      );
      expect(await repo.cancelIfCancellable(id, 'default')).toBeNull();
      expect((await repo.getTransfer(id))!.status).toBe(status);
    }
  });

  it('returns null for a CHARGED awaiting_payment row (fundingRef set): the resume sweep owns it', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_chg_await', fundingRef: 'mockfund-cc_chg_await' }));
    expect(await repo.cancelIfCancellable('cc_chg_await', 'default')).toBeNull();
    expect((await repo.getTransfer('cc_chg_await'))!.status).toBe('awaiting_payment');
  });

  it('a capture that lands first (setFundingRef) makes the void miss, and the charged row stays visible to the resume sweep', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_cap' }));
    await repo.setFundingRef('cc_cap', 'mockfund-cc_cap');
    expect(await repo.cancelIfCancellable('cc_cap', 'default')).toBeNull();
    const resumable = await repo.listAwaitingWithFunding(0, new Date(Date.now() + 60_000));
    expect(resumable.map((t) => t.id)).toContain('cc_cap');
  });

  it('a paid flip that lands first makes the void miss and leaves paid (the claim decides, not the read)', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_late' }));
    expect((await repo.markPaidIfAwaiting('cc_late'))?.status).toBe('paid');
    expect(await repo.cancelIfCancellable('cc_late', 'default')).toBeNull();
    expect((await repo.getTransfer('cc_late'))!.status).toBe('paid');
  });

  it('CONCURRENT paid claim + void: exactly one wins and the ledger holds the winner', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_race' }));
    const [paid, voided] = await Promise.all([
      repo.markPaidIfAwaiting('cc_race'),
      repo.cancelIfCancellable('cc_race', 'default'),
    ]);
    expect([paid, voided].filter((r) => r !== null)).toHaveLength(1);
    expect((await repo.getTransfer('cc_race'))!.status).toBe(paid ? 'paid' : 'cancelled');
  });
});

describe('transfer-repo — fix 6 (ctx-01): guarded payout write + rehydration probes', () => {
  const NEW = { payoutMethod: 'bank' as const, payoutDestination: '987654321098 SBIN0001234' };

  it('setPayoutIfEditable writes ONLY the payout columns — the encrypted legal name, EDD fields and status survive', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Mother Legal Name', relationship: 'parent', purpose: 'family_support' }));
    const updated = await repo.setPayoutIfEditable('tr_1', 'default', NEW);
    expect(updated?.status).toBe('awaiting_payment');
    const full = await repo.getTransfer('tr_1', { decrypt: true });
    expect(full?.payoutDestination).toBe(NEW.payoutDestination);
    expect(full?.recipientLegalName).toBe('Mother Legal Name');
    expect(full?.relationship).toBe('parent');
    expect(full?.purpose).toBe('family_support');
  });

  it('refuses (null, row untouched) for a paid / in_review / charged / B2B / other-tenant / partner-API row', async () => {
    await seedPartner(db, 'acme');
    const cases: Array<[string, Partial<Transfer>]> = [
      ['p_paid', { status: 'paid' }],
      ['p_review', { status: 'in_review' }],
      ['p_charged', { fundingRef: 'mockfund-p_charged' }],
      ['p_b2b', { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }],
      ['p_acme', { partnerId: 'acme' }],
      ['p_api', {}],
      ['p_api_audit', {}],
    ];
    for (const [id, over] of cases) await repo.saveTransfer(fixture({ id, ...over }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'p_api');          // a partner-API claim
    await createAuditRepo(db).record({ partnerId: 'default', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'p_api_audit' });
    for (const [id] of cases) {
      expect(await repo.setPayoutIfEditable(id, 'default', NEW), id).toBeNull();
      expect(await repo.isPayoutEditable(id, 'default'), id).toBe(false);
      expect((await repo.getTransfer(id, { decrypt: true }))?.payoutDestination, id).toBe('123456789012|HDFC0001234');
    }
  });

  it('a pay-page draft claim (draft:<id> under default) does NOT lock the payout', async () => {
    await repo.saveTransfer(fixture({ id: 'p_draft' }));
    await createIdempotencyRepo(db).claim('default', 'draft:d_1', 'p_draft');
    expect(await repo.isPayoutEditable('p_draft', 'default')).toBe(true);
    expect((await repo.setPayoutIfEditable('p_draft', 'default', NEW))?.id).toBe('p_draft');
  });

  it('Program-Fix 32: a schedule claim (sched:<scheduleId>:<day> under the schedule partner) does NOT lock the payout', async () => {
    // A cron mint binds its key claim-first; a scheduled link is often minted
    // with an EMPTY destination the customer enters on the pay page, so the
    // schedule claim must not read as "partner-API-minted".
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'p_sched', partnerId: 'acme', payoutDestination: '' }));
    await createIdempotencyRepo(db).claim('acme', 'sched:s_1:2026-06-09', 'p_sched');
    expect(await repo.isPayoutEditable('p_sched', 'acme')).toBe(true);
    expect((await repo.setPayoutIfEditable('p_sched', 'acme', NEW))?.id).toBe('p_sched');
  });

  it('hasB2bTransferTo is an exact (tenant, sender, recipient, b2b) probe', async () => {
    await repo.saveTransfer(fixture({ id: 'b_1', transferType: 'b2b', recipientPhone: '919822222222' }));
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919822222222')).toBe(true);
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919876543210')).toBe(false);
    expect(await repo.hasB2bTransferTo('acme', '15551230000', '919822222222')).toBe(false);
  });

  it('latestSettledConsumerTo returns the newest paid/delivered b2c row in the destination country, DECRYPTED', async () => {
    await repo.saveTransfer(fixture({ id: 's_old', status: 'delivered', createdAt: '2026-06-01T00:00:00.000Z', payoutDestination: 'OLD 111111111111' }));
    await repo.saveTransfer(fixture({ id: 's_new', status: 'paid', createdAt: '2026-06-05T00:00:00.000Z', payoutDestination: 'NEW 222222222222' }));
    await repo.saveTransfer(fixture({ id: 's_await', status: 'awaiting_payment', createdAt: '2026-06-09T00:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 's_gb', status: 'delivered', createdAt: '2026-06-10T00:00:00.000Z', destinationCountry: 'GB', destinationCurrency: 'GBP' }));
    const hit = await repo.latestSettledConsumerTo('default', '15551230000', '919876543210', 'IN');
    expect(hit?.id).toBe('s_new');
    expect(hit?.payoutDestination).toBe('NEW 222222222222');
    expect(await repo.latestSettledConsumerTo('default', '15551230000', '919876543210', 'AE')).toBeNull();
  });

  it('setAchTokenIfAbsent writes ONLY ach_token_ref, once, on an awaiting B2B row of this tenant — the legal name and status survive', async () => {
    const b2b = { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business', fundingMethod: 'ach_pull' } as const;
    await repo.saveTransfer(fixture({ id: 'a_1', ...b2b, recipientLegalName: 'Globex Trading Private Limited' }));
    await repo.saveTransfer(fixture({ id: 'a_paid', ...b2b, status: 'paid' }));
    await repo.saveTransfer(fixture({ id: 'a_b2c' }));
    expect(await repo.setAchTokenIfAbsent('a_1', 'acme', 'ach_x')).toBeNull();                        // other tenant
    expect((await repo.setAchTokenIfAbsent('a_1', 'default', 'ach_first'))?.achTokenRef).toBe('ach_first');
    expect(await repo.setAchTokenIfAbsent('a_1', 'default', 'ach_second')).toBeNull();                // the FIRST mandate is kept
    const full = await repo.getTransfer('a_1', { decrypt: true });
    expect(full?.achTokenRef).toBe('ach_first');
    expect(full?.recipientLegalName).toBe('Globex Trading Private Limited');
    expect(full?.status).toBe('awaiting_payment');
    expect(await repo.setAchTokenIfAbsent('a_paid', 'default', 'ach_x')).toBeNull();                  // moved on — untouched
    expect((await repo.getTransfer('a_paid'))?.achTokenRef).toBeUndefined();
    expect((await repo.getTransfer('a_paid'))?.status).toBe('paid');
    expect(await repo.setAchTokenIfAbsent('a_b2c', 'default', 'ach_x')).toBeNull();                   // a consumer row never carries a mandate
  });
});

describe('transfer-repo — fix 10 review nit: hasB2bTransferTo matches the NORMALIZED recipient phone', () => {
  it('a B2B row stored with a formatted recipient phone is still found by its digits-only form', async () => {
    await repo.saveTransfer(fixture({ id: 'bn_1', transferType: 'b2b', recipientPhone: '+91 98222-22222' }));
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919822222222')).toBe(true);
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919822222223')).toBe(false);
    expect(await repo.hasB2bTransferTo('acme', '15551230000', '919822222222')).toBe(false);
  });
});

// Program fix 16 (Task 10, test 5): the cap / velocity / EDD totals are
// aggregates over the ledger, tenant-scoped, over a plain created_at range.
describe('senderTotalsSince (fix 16: ledger totals under one query)', () => {
  const PHONE = '15551230000';
  const DAY = new Date('2026-06-10T04:00:00.000Z');   // ET midnight, June 10
  const MONTH = new Date('2026-06-01T04:00:00.000Z'); // ET midnight, June 1

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'acme');
    repo = createTransferRepo(db, provider);
    const at = (h: number) => new Date(DAY.getTime() + h * 3_600_000).toISOString();
    const row = (id: string, over: Partial<Transfer>) => repo.saveTransfer(fixture({ id, phone: PHONE, ...over }));
    // Today, tenant A: one of each status.
    await row('a_await', { status: 'awaiting_payment', amountUsd: 100, createdAt: at(1) });
    await row('a_paid', { status: 'paid', amountUsd: 200, createdAt: at(2) });
    await row('a_review', { status: 'in_review', amountUsd: 30, createdAt: at(3) });
    await row('a_deliv', { status: 'delivered', amountUsd: 40, createdAt: at(4) });
    await row('a_cancel', { status: 'cancelled', amountUsd: 500, createdAt: at(5) });
    await row('a_blocked', { status: 'blocked', complianceStatus: 'blocked', amountUsd: 700, createdAt: at(6) });
    // Yesterday (ET) and earlier this month, tenant A.
    await row('a_yday', { status: 'paid', amountUsd: 1000, createdAt: at(-1) });
    await row('a_m1', { status: 'delivered', amountUsd: 55.55, createdAt: new Date(MONTH.getTime() + 3_600_000).toISOString() });
    // Last month, tenant A — outside every window.
    await row('a_lastm', { status: 'paid', amountUsd: 9000, createdAt: new Date(MONTH.getTime() - 3_600_000).toISOString() });
    // Today, tenant B, same phone — must never count for A.
    await row('b_today', { status: 'paid', amountUsd: 5000, createdAt: at(1), partnerId: 'acme' });
  });

  it('sums today’s awaiting/paid/in_review/delivered only; counts everything but blocked; month includes prior days', async () => {
    const t = await repo.senderTotalsSince('default', PHONE, DAY, MONTH);
    expect(t).toEqual({
      todayUsdCents: 37_000,          // 100 + 200 + 30 + 40 (cancelled + blocked excluded)
      todayCount: 5,                  // 6 rows today minus the blocked one (cancelled counts, like countByPhone)
      monthUsdCents: 37_000 + 100_000 + 5_555, // + yesterday $1,000 + June 1 $55.55
    });
    expect(typeof t.todayUsdCents).toBe('number');
    expect(typeof t.monthUsdCents).toBe('number');
    expect(typeof t.todayCount).toBe('number');
  });

  it('is tenant-scoped: the other tenant sees only its own row, and an unknown sender is all zeros', async () => {
    expect(await repo.senderTotalsSince('acme', PHONE, DAY, MONTH)).toEqual({
      todayUsdCents: 500_000, todayCount: 1, monthUsdCents: 500_000,
    });
    expect(await repo.senderTotalsSince('default', '15550000000', DAY, MONTH)).toEqual({
      todayUsdCents: 0, todayCount: 0, monthUsdCents: 0,
    });
  });

  it('the day boundary is inclusive of dayStart and exclusive of the instant before', async () => {
    await repo.saveTransfer(fixture({ id: 'edge_in', phone: PHONE, amountUsd: 1, createdAt: DAY.toISOString() }));
    await repo.saveTransfer(fixture({ id: 'edge_out', phone: PHONE, amountUsd: 2, createdAt: new Date(DAY.getTime() - 1).toISOString() }));
    const t = await repo.senderTotalsSince('default', PHONE, DAY, MONTH);
    expect(t.todayUsdCents).toBe(37_000 + 100);
    expect(t.monthUsdCents).toBe(37_000 + 100_000 + 5_555 + 100 + 200);
  });
});
