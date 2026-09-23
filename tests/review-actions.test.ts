import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { createStore, type Store } from '@/lib/store';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';
import { POSSIBLE_MATCH_REASON, LIST_UNAVAILABLE_REASON } from '@/lib/compliance';
import type { Db } from '@/db/client';

// pg-backed store rebuilt per test (freshDb truncates); the hoisted mock
// factory must NOT construct it — getStore closes over the let lazily.
let store: Store;
let db: Db;

// Mock auth so we can control who is calling
const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireAdmin: () => mockRequireAdmin(),
  requireStaff: vi.fn(),
  requirePlatformAdmin: vi.fn(),
  requireScope: vi.fn(),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => db,
}));

import {
  releaseTransferAction,
  rejectTransferAction,
  issueRefundAction,
  approveRefundAction,
  dismissRefundAction,
  retryRefundAction,
} from '@/app/admin-dashboard/actions';

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567',
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'flagged',
    complianceReasons: ['Large transfer amount.'],
    status: 'in_review',
    createdAt: '2026-05-30T00:00:00Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    paidAt: '2026-05-30T01:00:00Z',
    ...overrides,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  mockRequireAdmin.mockReset();
});

describe('releaseTransferAction', () => {
  it('releases an in_review transfer to paid (a settlement) when admin calls it', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rr1' }));

    await releaseTransferAction(form({ id: 'rr1', note: 'docs verified' }));

    const loaded = await store.getTransfer('rr1');
    expect(loaded?.status).toBe('paid');
  });

  it('throws (auth rejected) when requireAdmin throws', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));

    await expect(releaseTransferAction(form({ id: 'any' }))).rejects.toThrow('Forbidden');
  });

  it('throws when transfer is not in_review', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rr2', status: 'delivered' }));

    await expect(releaseTransferAction(form({ id: 'rr2', note: 'docs verified' }))).rejects.toThrow(/not in_review/i);
  });
});

// OWNER DECISION (2026-09-16): releasing a transfer that SmartRemit's OWN
// screening flagged (owning partner kycMode 'ours') requires PLATFORM staff. A
// partner-scoped admin may release only a 'delegated'-mode partner's hold.
describe('releaseTransferAction — platform staff required for an ours-mode hold', () => {
  async function outboxRows() {
    const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
  }

  it("refuses a PARTNER-scoped admin releasing a flagged transfer of a kycMode 'ours' partner: row stays in_review, NO outbox row", async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'padmin', role: 'admin', partnerId: 'default' });
    await store.saveTransfer(makeTransfer({ id: 'own1', partnerId: 'default' })); // 'default' is kycMode 'ours'

    await expect(releaseTransferAction(form({ id: 'own1' }))).rejects.toThrow(/permission/i);

    expect((await store.getTransfer('own1'))?.status).toBe('in_review');
    expect(await outboxRows()).toHaveLength(0);
  });

  it("a PLATFORM admin releases the same ours-mode hold: paid + the rail effect is enqueued", async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'plat', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'own2', partnerId: 'default' }));

    await releaseTransferAction(form({ id: 'own2', note: 'docs verified' }));

    expect((await store.getTransfer('own2'))?.status).toBe('paid');
    expect(await outboxRows()).toEqual([{ kind: 'mock.settle', dedupe_key: 'mocksettle:own2' }]);
  });

  it("a PARTNER-scoped admin can still release a kycMode 'delegated' partner's own hold", async () => {
    await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
      VALUES ('delg', 'Delegated Co', 'active', '["US"]'::jsonb, 'delegated')`);
    mockRequireAdmin.mockResolvedValue({ username: 'dadmin', role: 'admin', partnerId: 'delg' });
    await store.saveTransfer(makeTransfer({ id: 'del1', partnerId: 'delg' }));

    await releaseTransferAction(form({ id: 'del1', note: 'docs verified' }));

    expect((await store.getTransfer('del1'))?.status).toBe('paid');
    expect(await outboxRows()).toEqual([{ kind: 'mock.settle', dedupe_key: 'mocksettle:del1' }]);
  });
});

// Program-Fix 43 follow-up (owner-directed): (1) every release records a
// REASON — refused before any mutation when the bounded note is blank, for
// platform and partner staff alike; (2) a hold that sanctions / name screening
// raised is PLATFORM-only to release, even for a kycMode 'delegated' partner.
describe('releaseTransferAction — mandatory reason + screening holds are platform-only', () => {
  async function outboxRows() {
    const r = await db.execute(sql`SELECT kind FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string }> }).rows;
  }
  async function auditRows() {
    const r = await db.execute(sql`SELECT action FROM audit_events ORDER BY id`);
    return (r as unknown as { rows: Array<{ action: string }> }).rows;
  }
  async function delegatedPartner() {
    await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
      VALUES ('delg', 'Delegated Co', 'active', '["US"]'::jsonb, 'delegated')`);
  }

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['control characters only', '\u0000 \u0007 '],
  ])('refuses a PLATFORM admin release with a %s note: stays in_review, no outbox row, no audit row', async (_label, note) => {
    mockRequireAdmin.mockResolvedValue({ username: 'plat', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'nr1' }));
    const values: Record<string, string> = { id: 'nr1' };
    if (note !== undefined) values.note = note;

    await expect(releaseTransferAction(form(values))).rejects.toThrow(/reason is required/i);

    expect((await store.getTransfer('nr1'))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses a delegated partner's admin releasing a blank-note hold too", async () => {
    await delegatedPartner();
    mockRequireAdmin.mockResolvedValue({ username: 'dadmin', role: 'admin', partnerId: 'delg' });
    await store.saveTransfer(makeTransfer({ id: 'nr2', partnerId: 'delg' }));

    await expect(releaseTransferAction(form({ id: 'nr2', note: ' ' }))).rejects.toThrow(/reason is required/i);
    expect((await store.getTransfer('nr2'))?.status).toBe('in_review');
    expect(await auditRows()).toEqual([]);
  });

  it("a delegated partner's admin releasing with a reason writes transfer.release with actor + reason", async () => {
    await delegatedPartner();
    mockRequireAdmin.mockResolvedValue({ username: 'dadmin', role: 'admin', partnerId: 'delg' });
    await store.saveTransfer(makeTransfer({ id: 'nr3', partnerId: 'delg' }));

    await releaseTransferAction(form({ id: 'nr3', note: 'source of funds verified' }));

    const r = await db.execute(sql`SELECT actor, action, meta FROM audit_events ORDER BY id`);
    expect((r as unknown as { rows: unknown[] }).rows).toEqual([
      { actor: 'dadmin', action: 'transfer.release', meta: expect.objectContaining({ reason: 'source of funds verified' }) },
    ]);
  });

  it.each([
    [POSSIBLE_MATCH_REASON],
    [LIST_UNAVAILABLE_REASON],
  ])("refuses a delegated partner's admin releasing a SCREENING hold (%s): stays in_review, no outbox, no audit", async (reason) => {
    await delegatedPartner();
    mockRequireAdmin.mockResolvedValue({ username: 'dadmin', role: 'admin', partnerId: 'delg' });
    await store.saveTransfer(makeTransfer({ id: 'sc1', partnerId: 'delg', complianceReasons: ['Large transfer amount.', reason] }));

    await expect(releaseTransferAction(form({ id: 'sc1', note: 'looks fine to us' }))).rejects.toThrow(/permission/i);

    expect((await store.getTransfer('sc1'))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('a PLATFORM admin may still release a screening hold (with a reason)', async () => {
    await delegatedPartner();
    mockRequireAdmin.mockResolvedValue({ username: 'plat', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'sc2', partnerId: 'delg', complianceReasons: [POSSIBLE_MATCH_REASON] }));

    await releaseTransferAction(form({ id: 'sc2', note: 'false positive, cleared by platform compliance' }));

    expect((await store.getTransfer('sc2'))?.status).toBe('paid');
    expect(await auditRows()).toEqual([{ action: 'transfer.release' }]);
  });
});

describe('rejectTransferAction', () => {
  it('cancels an in_review transfer with adminNote when admin calls it', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rj1' }));

    await rejectTransferAction(form({ id: 'rj1' }));

    const loaded = await store.getTransfer('rj1');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.adminNote).toContain('rejected in review');
  });

  it('throws (auth rejected) when requireAdmin throws', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));

    await expect(rejectTransferAction(form({ id: 'any' }))).rejects.toThrow('Forbidden');
  });

  it('throws when transfer is not in_review', async () => {
    mockRequireAdmin.mockResolvedValue({ username: 'admin', role: 'admin' });
    await store.saveTransfer(makeTransfer({ id: 'rj2', status: 'awaiting_payment' }));

    await expect(rejectTransferAction(form({ id: 'rj2' }))).rejects.toThrow(/not in_review/i);
  });
});

// ── Program-Fix 28 (compliance-03/-08): every admin money action writes ONE
// audit_events row whose actor is the SESSION user (never a form field) and
// whose reason is the optional, bounded `note` field.
describe('admin money actions write the durable audit row (Program-Fix 28)', () => {
  type Row = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
  async function auditRows(): Promise<Row[]> {
    const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
    return (r as unknown as { rows: Row[] }).rows;
  }
  beforeEach(() => mockRequireAdmin.mockResolvedValue({ username: 'plat', name: 'Platform Admin', role: 'admin' }));

  it('release: transfer.release row, actor = session username (a posted actor field is ignored), reason = bounded note', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_rel' }));
    await releaseTransferAction(form({ id: 'au_rel', note: '  source\u0000 of funds ok ', actor: 'mallory' }));
    expect(await auditRows()).toEqual([{
      partner_id: 'default', actor: 'plat', actor_type: 'staff', action: 'transfer.release', subject_id: 'au_rel',
      meta: { previousStatus: 'in_review', newStatus: 'paid', reason: 'source of funds ok' },
    }]);
  });

  it('reject: transfer.reject row; no note ⇒ reason null; a 900-char note is cut to 500', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_rej' }));
    await store.saveTransfer(makeTransfer({ id: 'au_rej2' }));
    await rejectTransferAction(form({ id: 'au_rej' }));
    await rejectTransferAction(form({ id: 'au_rej2', note: 'n'.repeat(900) }));
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actor, r.subject_id])).toEqual([
      ['transfer.reject', 'plat', 'au_rej'],
      ['transfer.reject', 'plat', 'au_rej2'],
    ]);
    expect(rows[0].meta.reason).toBeNull();
    expect((rows[1].meta.reason as string).length).toBe(500);
  });

  it('issueRefundAction: refund.issue row with reason null (the confirm button carries no note)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_iss', status: 'paid', fundingRef: 'mockfund-au_iss' }));
    await issueRefundAction(form({ id: 'au_iss' }));
    expect(await auditRows()).toEqual([expect.objectContaining({
      actor: 'plat', actor_type: 'staff', action: 'refund.issue', subject_id: 'au_iss',
      meta: expect.objectContaining({ refundStatus: 'pending', reason: null }),
    })]);
  });

  it('approveRefundAction: refund.approve row with the note as reason', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_apr', status: 'cancelled', fundingRef: 'f', refundStatus: 'requested' }));
    await approveRefundAction(form({ id: 'au_apr', note: 'customer called in' }));
    expect(await auditRows()).toEqual([expect.objectContaining({
      actor: 'plat', action: 'refund.approve', subject_id: 'au_apr',
      meta: expect.objectContaining({ previousRefundStatus: 'requested', refundStatus: 'pending', reason: 'customer called in' }),
    })]);
  });

  it('dismissRefundAction: refund.dismiss row', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_dis', status: 'cancelled', fundingRef: 'f', refundStatus: 'requested' }));
    await dismissRefundAction(form({ id: 'au_dis', note: 'duplicate request' }));
    expect(await auditRows()).toEqual([expect.objectContaining({
      actor: 'plat', action: 'refund.dismiss', subject_id: 'au_dis',
      meta: expect.objectContaining({ refundStatus: 'none', reason: 'duplicate request' }),
    })]);
  });

  it('retryRefundAction: refund.retry row', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_rty', status: 'cancelled', fundingRef: 'f', refundStatus: 'failed' }));
    await retryRefundAction(form({ id: 'au_rty' }));
    expect(await auditRows()).toEqual([expect.objectContaining({
      actor: 'plat', action: 'refund.retry', subject_id: 'au_rty',
      meta: expect.objectContaining({ previousRefundStatus: 'failed', refundStatus: 'pending', reason: null }),
    })]);
  });

  it('a refused action (wrong state) writes NO audit row', async () => {
    await store.saveTransfer(makeTransfer({ id: 'au_no', status: 'delivered' }));
    await expect(releaseTransferAction(form({ id: 'au_no', note: 'x' }))).rejects.toThrow(/not in_review/i);
    await expect(approveRefundAction(form({ id: 'au_no' }))).rejects.toThrow(/not awaiting approval/i);
    expect(await auditRows()).toEqual([]);
  });
});
