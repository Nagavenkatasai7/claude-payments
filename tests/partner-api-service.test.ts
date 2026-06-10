import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import {
  listCorridors, createQuote, validateBeneficiary, createBeneficiary,
  createTransaction, getTransaction, confirmTransaction, type PartnerApiDeps,
} from '@/lib/partner-api-service';
import type { Partner } from '@/lib/types';

const NOW = '2026-06-08T00:00:00Z';

async function harness() {
  const redis = fakeRedis();
  // partnerStore + integrationsStore + the transfer ledger are Postgres-backed
  // now; they share ONE db handle. Beneficiaries/volume/idempotency/audit stay
  // on fakeRedis this slice.
  const db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
  const store = createStore(redis, db);
  let n = 0;
  const deps: PartnerApiDeps = {
    store,
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(redis),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    db,
    now: () => NOW,
    genId: () => `b${n++}`,
    // Deterministic settlement: mark paid without WhatsApp/timers. Read the
    // DECRYPTED row — re-saving a default (masked) read would clobber the
    // stored payout destination with the mask.
    initiatePayment: async (t) => {
      const cur = await store.getTransferDecrypted(t.id);
      if (cur) await store.saveTransfer({ ...cur, status: 'paid', paidAt: NOW });
    },
  };
  return { redis, store, deps };
}

function partner(over: Partial<Partner>): Partner {
  return { id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW, ...over };
}
const DELEGATED = partner({ id: 'acme', displayName: 'Acme Pay', kycMode: 'delegated', requireKycBeforeSend: false });
const OURS = partner({ id: 'globex' }); // default kycMode ⇒ 'ours' ⇒ gate ON

const txBody = (over: Record<string, unknown> = {}) => ({
  amount_source: 200,
  sender: { phone: '15551230000', name: 'Sender', kyc_status: 'not_started' },
  beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
  ...over,
});

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '',
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('partner-api-service: read endpoints', () => {
  it('listCorridors maps the partner countries → IN corridors + brand', () => {
    const r = listCorridors(DELEGATED);
    expect(r.brand).toBe('Acme Pay');
    expect(r.corridors[0]).toMatchObject({ source_currency: 'USD', destination_country: 'IN', destination_currency: 'INR' });
  });

  it('createQuote returns a quote; rejects a non-positive amount', async () => {
    const { deps } = await harness();
    const okq = await createQuote(deps, DELEGATED, { amount_source: 500 });
    expect(okq.ok).toBe(true);
    if (okq.ok) expect(okq.data).toMatchObject({ source_currency: 'USD', destination_currency: 'INR' });
    expect(await createQuote(deps, DELEGATED, { amount_source: 0 })).toMatchObject({ ok: false, status: 400 });
  });

  it('validateBeneficiary: valid IN fields pass, bad ones 422', () => {
    expect(validateBeneficiary({ country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } }))
      .toMatchObject({ ok: true });
    expect(validateBeneficiary({ country: 'IN', fields: { accountNumber: '1', ifsc: 'bad' } }))
      .toMatchObject({ ok: false, status: 422 });
  });
});

describe('partner-api-service: createTransaction', () => {
  it('delegated partner mints for an UNVERIFIED sender (201), sanctions still ran', async () => {
    const { deps } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-1', txBody());
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (r.ok) expect((r.data as { status: string }).status).toBe('awaiting_payment');
  });

  it('is IDEMPOTENT — the same Idempotency-Key returns the same transaction', async () => {
    const { deps } = await harness();
    const first = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-1', txBody());
    const second = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-1', txBody({ amount_source: 999 }));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.status).toBe(200); // replay
      expect((second.data as { id: string }).id).toBe((first.data as { id: string }).id);
    }
  });

  it('CLAIM-FIRST: a crash between claim and mint replays into the SAME claimed id', async () => {
    const { deps } = await harness();
    // Simulate the crash window: the key is bound but no transfer was minted.
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    const claimed = await createIdempotencyRepo(deps.db).claim('acme', 'idem-crash', 'tr_crashed');
    expect(claimed).toBe('tr_crashed');

    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-crash', txBody());
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (r.ok) expect((r.data as { id: string }).id).toBe('tr_crashed');
    expect(await deps.store.getTransfer('tr_crashed')).not.toBeNull();
  });

  it('CONCURRENT duplicates with the same key converge on ONE transfer row', async () => {
    const { deps, store } = await harness();
    const [a, b] = await Promise.all([
      createTransaction(deps, DELEGATED, 'pk_1', 'idem-race', txBody()),
      createTransaction(deps, DELEGATED, 'pk_1', 'idem-race', txBody()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect((a.data as { id: string }).id).toBe((b.data as { id: string }).id);
    }
    expect(await store.listTransfers()).toHaveLength(1);
  });

  it('requires an Idempotency-Key and a sender phone', async () => {
    const { deps } = await harness();
    expect(await createTransaction(deps, DELEGATED, 'pk_1', '', txBody())).toMatchObject({ ok: false, status: 400 });
    expect(await createTransaction(deps, DELEGATED, 'pk_1', 'k', txBody({ sender: {} }))).toMatchObject({ ok: false, status: 400 });
  });

  it('SANCTIONS SURVIVE DELEGATION — a watchlisted beneficiary is 422 (and recorded blocked)', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-x', txBody({
      beneficiary: { name: 'John Doe', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
    }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    // Transfers live in Postgres now — find the recorded row via the store API.
    const [t] = await store.listTransfers();
    expect(t).toBeDefined();
    expect(t.status).toBe('blocked');
  });

  it("an 'ours' partner rejects an UNVERIFIED sender with 422 (KYC required)", async () => {
    const { deps } = await harness();
    await deps.partnerStore.savePartner(OURS);
    const r = await createTransaction(deps, OURS, 'pk_1', 'idem-2', txBody());
    expect(r).toMatchObject({ ok: false, status: 422 });
  });

  it('resolves a stored beneficiary by id (partner-scoped)', async () => {
    const { deps } = await harness();
    const ben = await createBeneficiary(deps, 'acme', { name: 'Anita', country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' }, recipient_phone: '919876543210' });
    expect(ben).toMatchObject({ ok: true, status: 201 });
    const benId = ben.ok ? (ben.data as { id: string }).id : '';
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-3', { amount_source: 150, sender: { phone: '15551230000' }, beneficiary_id: benId });
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (r.ok) expect((r.data as { recipient_name: string }).recipient_name).toBe('Anita');
  });
});

describe('partner-api-service: cross-tenant isolation', () => {
  it('getTransaction returns 404 for a transfer owned by another partner', async () => {
    const { deps } = await harness();
    const created = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-1', txBody());
    const id = created.ok ? (created.data as { id: string }).id : '';
    // owner can read
    expect(await getTransaction(deps, 'acme', id)).toMatchObject({ ok: true, status: 200 });
    // a different partner gets 404 (never 403 — don't disclose existence)
    expect(await getTransaction(deps, 'rival', id)).toMatchObject({ ok: false, status: 404 });
  });

  it('confirmTransaction is owner-scoped and drives settlement', async () => {
    const { deps } = await harness();
    const created = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-1', txBody());
    const id = created.ok ? (created.data as { id: string }).id : '';
    // a rival cannot confirm someone else's transfer
    expect(await confirmTransaction(deps, partner({ id: 'rival' }), 'pk_r', id)).toMatchObject({ ok: false, status: 404 });
    // owner confirms → paid
    const r = await confirmTransaction(deps, DELEGATED, 'pk_1', id);
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) expect((r.data as { status: string }).status).toBe('paid');
  });
});
