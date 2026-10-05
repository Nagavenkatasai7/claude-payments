import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createScopedStore } from '@/lib/scoped-store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { reconcileSweep } from '@/lib/reconcile';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

// Release safety Batch 2 part B: one synthetic SANDBOX transfer per deploy must
// not change staff numbers. A sandbox row stuck in 'paid' is not a stuck payment
// (no recon alert, no "Stuck paid" count), and the Overview "Recent
// transactions", the partner detail list and the compliance in-review list
// show live rows only. The Transactions page still lists every environment.

const ADMIN: Staff = {
  username: 'admin', name: 'Admin', role: 'admin',
  permissions: { canCancel: true, canResend: true, canAssign: true },
  passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
};

function t(id: string, over: Partial<Transfer> = {}): Transfer {
  return {
    id, phone: '15555550142', amountUsd: 10, feeUsd: 1, totalChargeUsd: 11,
    fxRate: 83, amountInr: 830, recipientName: 'Synthetic Recipient', recipientPhone: '',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(),
    partnerId: 'synth', sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 10, feeSource: 1, totalChargeSource: 11,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'synth');
  await store.saveTransfer(t('sbx_paid', { environment: 'test' }));
  await store.saveTransfer(t('sbx_review', { environment: 'test', status: 'in_review', complianceStatus: 'flagged', paidAt: undefined }));
  await store.saveTransfer(t('live_paid', { phone: '15555550143', createdAt: new Date(Date.now() - 7_200_000).toISOString() }));
});

describe('sandbox rows and staff numbers', { retry: 0 }, () => {
  it('findStuckPaid lists the live row only', async () => {
    const ids = (await createTransferRepo(db).findStuckPaid(15)).map((x) => x.id);
    expect(ids).toEqual(['live_paid']);
  });

  it('reconcileSweep never alerts on a sandbox row stuck in paid', async () => {
    await reconcileSweep(db);
    const r = (await db.execute(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ k: string }> };
    const keys = r.rows.map((x) => x.k);
    expect(keys).not.toContain('recon:sbx_paid');
    expect(keys).toContain('recon:live_paid');
  });

  it('Overview recent, partner detail and in-review lists are live only; the Transactions page lists both', async () => {
    const scoped = createScopedStore(ADMIN, { store } as never);
    expect((await scoped.recentTransfers(5)).map((x) => x.id)).toEqual(['live_paid']);
    expect((await scoped.transfersPage({ limit: 50, partnerFilter: 'synth', environment: 'live' })).items.map((x) => x.id)).toEqual(['live_paid']);
    expect((await scoped.transfersPage({ limit: 50 })).items.map((x) => x.id).sort()).toEqual(['live_paid', 'sbx_paid', 'sbx_review']);
    const views = await scoped.complianceViews();
    expect(views.inReview.map((x) => x.id)).toEqual([]);
  });
});
