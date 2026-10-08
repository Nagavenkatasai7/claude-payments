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
import {
  createTransaction,
  getTransaction,
  listTransactions,
  PURPOSE_INVALID_422,
  PURPOSE_REQUIRED_422,
  type PartnerApiDeps,
} from '@/lib/partner-api-service';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { buildComplianceBlock } from '@/lib/providers/http-payment-provider';
import { TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import type { Partner } from '@/lib/types';

// Required purpose (owner decision 2026-10-08): POST /transactions needs `purpose`,
// one of the 8 values. Missing or unknown ⇒ 422, refused BEFORE the customer write
// and the Idempotency-Key claim (like client_reference), so a corrected retry with
// the same key mints normally. The purpose is stored on the transfer and returned.

vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

const NOW = '2026-06-08T00:00:00Z';

async function harness(keyMode: 'live' | 'test' = 'live') {
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
    keyMode,
    now: () => NOW,
    genId: () => `pur${n++}`,
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
  purpose: 'family_support',
  ...over,
});

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' })));
});
afterEach(() => vi.restoreAllMocks());

describe('POST /transactions purpose (required)', () => {
  it('the 422 messages are clear and list the 8 values', () => {
    expect(PURPOSE_REQUIRED_422).toMatch(/^purpose is required/);
    expect(PURPOSE_INVALID_422).toBe(`purpose must be one of: ${TRANSFER_PURPOSES.join(', ')}.`);
  });

  it('a valid purpose is stored on the transfer and comes back in create, get and list', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-ok', txBody({ purpose: 'medical' }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) return;
    const view = r.data as Record<string, unknown>;
    expect(view.purpose).toBe('medical');
    const t = await store.getTransfer(String(view.id));
    expect(t?.purpose).toBe('medical');
    const got = await getTransaction(deps, 'acme', String(view.id));
    expect(got.ok && (got.data as Record<string, unknown>).purpose).toBe('medical');
    const list = await listTransactions(deps, 'acme', {});
    expect(list.ok && (list.data as { transactions: Record<string, unknown>[] }).transactions[0].purpose).toBe('medical');
    // The signed settlement instruction's compliance block carries it as before; purpose_code stays null (Q4).
    expect(buildComplianceBlock(t!, null, new Date(NOW))).toMatchObject({ purpose: 'medical', purpose_code: null });
  });

  it('every one of the 8 purposes is accepted', async () => {
    const { deps } = await harness();
    let i = 0;
    for (const purpose of TRANSFER_PURPOSES) {
      const r = await createTransaction(deps, ACME, 'pk_1', `idem-each-${i}`, txBody({ purpose, sender: { phone: `1555000200${i++}`, name: 'S', kyc_status: 'verified' } }));
      expect(r.ok && (r.data as Record<string, unknown>).purpose, purpose).toBe(purpose);
    }
  });

  it('missing ⇒ 422 "purpose is required", with no customer row and no key claim', async () => {
    const { deps, db, customerStore } = await harness();
    for (const [i, purpose] of [undefined, null, ''].entries()) {
      const key = `idem-missing-${i}`;
      const phone = `1555000300${i}`;
      const body: Record<string, unknown> = txBody({ sender: { phone, name: 'S' } });
      if (purpose === undefined) delete body.purpose;
      else body.purpose = purpose;
      const r = await createTransaction(deps, ACME, 'pk_1', key, body);
      expect(r, String(purpose)).toEqual({ ok: false, status: 422, error: PURPOSE_REQUIRED_422 });
      expect(await createIdempotencyRepo(db).find('acme', key)).toBeNull();
      expect(await customerStore.getCustomer('acme', phone)).toBeNull();
    }
  });

  it('unknown (a label, a code, another case, a number) ⇒ 422 naming the 8 values, with no customer row and no key claim', async () => {
    const { deps, db, customerStore } = await harness();
    const bads: unknown[] = ['Family support', 'P1301', 'MEDICAL', 'charity', 'toString', 7, ['gift'], { purpose: 'gift' }];
    for (const [i, bad] of bads.entries()) {
      const key = `idem-bad-${i}`;
      const phone = `1555000400${i}`;
      const r = await createTransaction(deps, ACME, 'pk_1', key, txBody({ purpose: bad, sender: { phone, name: 'S' } }));
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, status: 422, error: PURPOSE_INVALID_422 });
      expect(await createIdempotencyRepo(db).find('acme', key)).toBeNull();
      expect(await customerStore.getCustomer('acme', phone)).toBeNull();
    }
  });

  it('a corrected retry with the SAME Idempotency-Key mints normally', async () => {
    const { deps } = await harness();
    const refused = await createTransaction(deps, ACME, 'pk_1', 'idem-retry', txBody({ purpose: undefined }));
    expect(refused).toMatchObject({ ok: false, status: 422 });
    const ok = await createTransaction(deps, ACME, 'pk_1', 'idem-retry', txBody({ purpose: 'gift' }));
    expect(ok).toMatchObject({ ok: true, status: 201 });
  });

  it('a sandbox (test key) mint needs a purpose too', async () => {
    const { deps } = await harness('test');
    const r = await createTransaction(deps, ACME, 'pk_test_1', 'idem-sbx', txBody({ purpose: undefined }));
    expect(r).toEqual({ ok: false, status: 422, error: PURPOSE_REQUIRED_422 });
    expect(await createTransaction(deps, ACME, 'pk_test_1', 'idem-sbx', txBody({ purpose: 'savings' }))).toMatchObject({ ok: true, status: 201 });
  });

  it('a replay of the same key returns the FIRST purpose', async () => {
    const { deps } = await harness();
    const first = await createTransaction(deps, ACME, 'pk_1', 'idem-rep', txBody({ purpose: 'education' }));
    const again = await createTransaction(deps, ACME, 'pk_1', 'idem-rep', txBody({ purpose: 'gift' }));
    expect(first.ok && again.ok).toBe(true);
    expect((again as { data: Record<string, unknown> }).data.purpose).toBe('education');
  });
});
