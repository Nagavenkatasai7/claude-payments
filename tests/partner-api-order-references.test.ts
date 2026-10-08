import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createCustomerStore } from '@/lib/customer-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { createTransaction, getTransaction, listTransactions, type PartnerApiDeps } from '@/lib/partner-api-service';
import { CLIENT_REFERENCE_ERROR } from '@/lib/order-references';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { buildSettlementInstruction } from '@/lib/providers/http-payment-provider';
import type { Partner } from '@/lib/types';

// Batch B1: the partner's order number (client_reference) on POST /transactions,
// and the payout partner's confirmation (payout_reference) in every answer.

vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

const NOW = '2026-06-08T00:00:00Z';

async function harness() {
  const redis = fakeRedis();
  const db = await freshDb();
  await seedPartner(db, 'acme');
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  let n = 0;
  const deps: PartnerApiDeps = {
    store,
    customerStore,
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    db,
    keyMode: 'live',
    now: () => NOW,
    genId: () => `ref${n++}`,
  };
  return { store, deps, db, customerStore };
}

const ACME: Partner = {
  id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW,
  kycMode: 'delegated', requireKycBeforeSend: false,
};

const txBody = (over: Record<string, unknown> = {}) => ({
  amount_source: 200,
  sender: { phone: '15551230000', name: 'Sender', kyc_status: 'verified' },
  beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
  ...over,
});

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' })));
});
afterEach(() => vi.restoreAllMocks());

describe('POST /transactions client_reference', () => {
  it('a valid client_reference is saved and comes back in create, get and list; payout_reference is null', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-ok', txBody({ client_reference: 'INV-2026/10#7' }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) return;
    const view = r.data as Record<string, unknown>;
    expect(view.client_reference).toBe('INV-2026/10#7');
    expect(view.payout_reference).toBeNull();
    expect((await store.getTransfer(String(view.id)))?.clientReference).toBe('INV-2026/10#7');
    const got = await getTransaction(deps, 'acme', String(view.id));
    expect(got.ok && (got.data as Record<string, unknown>).client_reference).toBe('INV-2026/10#7');
    const list = await listTransactions(deps, 'acme', {});
    expect(list.ok && (list.data as { transactions: Record<string, unknown>[] }).transactions[0].client_reference).toBe('INV-2026/10#7');
  });

  it('no client_reference is fine: both fields are null', async () => {
    const { deps } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-none', txBody());
    expect(r.ok && (r.data as Record<string, unknown>)).toMatchObject({ client_reference: null, payout_reference: null });
  });

  it('too long, bad characters or not a string: 400 with no customer row and no key claim', async () => {
    const { deps, db, customerStore } = await harness();
    const bads: unknown[] = ['x'.repeat(65), 'INV 1', 'a,b', '=SUM(A1)', '', 42, { a: 1 }];
    let i = 0;
    for (const bad of bads) {
      const key = `idem-bad-${i}`;
      const phone = `1555000100${i++}`;
      const r = await createTransaction(deps, ACME, 'pk_1', key, txBody({ client_reference: bad, sender: { phone, name: 'S' } }));
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, status: 400, error: CLIENT_REFERENCE_ERROR });
      expect(await createIdempotencyRepo(db).find('acme', key)).toBeNull();
      expect(await customerStore.getCustomer('acme', phone)).toBeNull();
    }
  });

  it('a repeat request with the same Idempotency-Key keeps the first value', async () => {
    const { deps, store } = await harness();
    const first = await createTransaction(deps, ACME, 'pk_1', 'idem-rep', txBody({ client_reference: 'PO-1' }));
    const again = await createTransaction(deps, ACME, 'pk_1', 'idem-rep', txBody({ client_reference: 'PO-2' }));
    expect(again).toMatchObject({ ok: true, status: 200 });
    expect(again.ok && (again.data as Record<string, unknown>).client_reference).toBe('PO-1');
    expect(first.ok && again.ok && (first.data as { id: string }).id).toBe((again.ok && (again.data as { id: string }).id));
    expect(await store.listTransfers()).toHaveLength(1);
  });

  it('the settlement instruction to the partner\'s own rail carries client_reference; a routed row does not', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-ins', txBody({ client_reference: 'PO-9' }));
    const t = (await store.getTransferDecrypted((r.ok && (r.data as { id: string }).id) || ''))!;
    expect(buildSettlementInstruction(t)).toMatchObject({ client_reference: 'PO-9' });
    expect(buildSettlementInstruction({ ...t, settlementPartnerId: 'globex' })).not.toHaveProperty('client_reference');
    expect(buildSettlementInstruction({ ...t, clientReference: undefined })).not.toHaveProperty('client_reference');
  });
});

describe('transfer-repo: both references are write-once', () => {
  it('setPayoutReference saves once; a second value never replaces it', async () => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-w1', txBody({ client_reference: 'PO-3' }));
    const id = (r.ok && (r.data as { id: string }).id) || '';
    const repo = createTransferRepo(db);
    expect(await repo.setPayoutReference(id, 'UTR-1')).toBe(true);
    expect(await repo.setPayoutReference(id, 'UTR-2')).toBe(false);
    expect((await repo.getTransfer(id))?.payoutReference).toBe('UTR-1');
    const got = await getTransaction(deps, 'acme', id);
    expect(got.ok && (got.data as Record<string, unknown>).payout_reference).toBe('UTR-1');
  });

  it('a read-modify-write saveTransfer never clears or changes either reference', async () => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-w2', txBody({ client_reference: 'PO-4' }));
    const id = (r.ok && (r.data as { id: string }).id) || '';
    const repo = createTransferRepo(db);
    const stale = (await repo.getTransfer(id, { decrypt: true }))!; // read BEFORE the callback
    await repo.setPayoutReference(id, 'UTR-9');
    await repo.saveTransfer({ ...stale, clientReference: 'CHANGED', adminNote: 'note' });
    await repo.saveTransfer({ ...stale, clientReference: undefined, payoutReference: undefined });
    const after = (await repo.getTransfer(id))!;
    expect(after.clientReference).toBe('PO-4');
    expect(after.payoutReference).toBe('UTR-9');
  });
});
