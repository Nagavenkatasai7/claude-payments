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
  PURPOSE_DETAIL_REQUIRED_422,
  PURPOSE_DETAIL_TYPE_422,
  PURPOSE_INVALID_422,
  PURPOSE_REQUIRED_422,
  purposeDetail422,
  type PartnerApiDeps,
} from '@/lib/partner-api-service';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { buildComplianceBlock } from '@/lib/providers/http-payment-provider';
import { TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import type { Partner } from '@/lib/types';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { sql } from 'drizzle-orm';

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

  it('every one of the 8 purposes is accepted (other with its purpose_detail)', async () => {
    const { deps } = await harness();
    let i = 0;
    for (const purpose of TRANSFER_PURPOSES) {
      const r = await createTransaction(deps, ACME, 'pk_1', `idem-each-${i}`, txBody({ purpose, ...(purpose === 'other' ? { purpose_detail: 'helping a neighbour repair the roof' } : {}), sender: { phone: `1555000200${i++}`, name: 'S', kyc_status: 'verified' } }));
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

// Batch B follow-up A3: purpose other needs purpose_detail (the sender's reason), checked with the
// purpose (before the customer write and the claim). Returned decrypted to the owning partner only.
describe('POST /transactions purpose_detail (required with purpose other)', () => {
  const view = (r: Awaited<ReturnType<typeof createTransaction>>) => (r.ok ? (r.data as Record<string, unknown>) : {});

  it('the 422 texts: required, type, and the shape reason (never a matched pattern)', () => {
    expect(PURPOSE_DETAIL_REQUIRED_422).toBe('purpose_detail is required when purpose is other (10 to 120 characters).');
    expect(purposeDetail422('missing')).toBe(PURPOSE_DETAIL_REQUIRED_422);
    expect(purposeDetail422('too_short')).toMatch(/too short.*10 to 120/);
    expect(purposeDetail422('too_long')).toMatch(/too long.*10 to 120/);
    expect(purposeDetail422('nonsense')).toMatch(/what the money is for/);
  });

  it('other without a valid purpose_detail ⇒ 422, no customer row, no key claim; the corrected retry mints', async () => {
    const { deps, db, customerStore } = await harness();
    const cases: Array<[unknown, string]> = [
      [undefined, PURPOSE_DETAIL_REQUIRED_422],
      [null, PURPOSE_DETAIL_REQUIRED_422],
      ['   ', PURPOSE_DETAIL_REQUIRED_422],
      ['rent', purposeDetail422('too_short')],
      ['helping my uncle with roof repairs '.repeat(4), purposeDetail422('too_long')],
      ['send money', purposeDetail422('nonsense')],
      [42, PURPOSE_DETAIL_TYPE_422],
      [['school fees'], PURPOSE_DETAIL_TYPE_422],
    ];
    for (const [i, [detail, message]] of cases.entries()) {
      const key = `idem-pd-${i}`;
      const phone = `1555000500${i}`;
      const r = await createTransaction(deps, ACME, 'pk_1', key, txBody({ purpose: 'other', purpose_detail: detail, sender: { phone, name: 'S' } }));
      expect(r, JSON.stringify(detail)).toEqual({ ok: false, status: 422, error: message });
      expect(await createIdempotencyRepo(db).find('acme', key)).toBeNull();
      expect(await customerStore.getCustomer('acme', phone)).toBeNull();
    }
    const fixed = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-0', txBody({
      purpose: 'other', purpose_detail: 'helping a neighbour repair the roof', sender: { phone: '15550005000', name: 'S' },
    }));
    expect(fixed).toMatchObject({ ok: true, status: 201 });
  });

  it('a plain reason: stored sealed, returned on create, get and list; compliance stays cleared', async () => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-ok', txBody({ purpose: 'other', purpose_detail: '  helping a neighbour   repair the roof ' }));
    const v = view(r);
    expect(v).toMatchObject({ purpose: 'other', purpose_detail: 'helping a neighbour repair the roof', compliance_status: 'cleared' });
    const [row] = (await db.execute(sql`SELECT purpose_detail_enc FROM transfers WHERE id = ${String(v.id)}`)).rows as Array<{ purpose_detail_enc: string }>;
    expect(row.purpose_detail_enc).toMatch(/^v2\./);
    const got = await getTransaction(deps, 'acme', String(v.id));
    expect(got.ok && (got.data as Record<string, unknown>).purpose_detail).toBe('helping a neighbour repair the roof');
    const list = await listTransactions(deps, 'acme', {});
    expect(list.ok && (list.data as { transactions: Record<string, unknown>[] }).transactions[0].purpose_detail).toBe('helping a neighbour repair the roof');
    // A replay returns the first reason.
    const again = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-ok', txBody({ purpose: 'other', purpose_detail: 'something else entirely here' }));
    expect(view(again).purpose_detail).toBe('helping a neighbour repair the roof');
  });

  it('a reason that names a purpose ⇒ that purpose, with the reason kept', async () => {
    const { deps } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-edu', txBody({ purpose: 'other', purpose_detail: 'school fees for my son' }));
    expect(view(r)).toMatchObject({ purpose: 'education', purpose_detail: 'school fees for my son' });
  });

  it('any other purpose ignores purpose_detail (nothing stored, null back)', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-gift', txBody({ purpose: 'gift', purpose_detail: 'to claim my lottery prize' }));
    expect(view(r)).toMatchObject({ purpose: 'gift', purpose_detail: null, compliance_status: 'cleared' });
    expect((await store.getTransfer(String(view(r).id), { decrypt: true }))?.purposeDetail).toBeUndefined();
  });

  it('a matching reason is held for review with the generic reason only; the answer names no rule', async () => {
    const { deps, store } = await harness();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-hold', txBody({ purpose: 'other', purpose_detail: 'to claim my lottery prize' }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    const v = view(r);
    expect(v).toMatchObject({ compliance_status: 'flagged', purpose: 'other', purpose_detail: 'to claim my lottery prize' });
    expect(JSON.stringify(v)).not.toMatch(/"prize"|category|scam|risk/i);
    expect((await store.getTransfer(String(v.id)))?.complianceReasons).toEqual([AML_HOLD_REASON]);
  });

  it('tenant isolation: another partner never reads the reason (404 on get, absent from its list and from a cross-tenant batch read)', async () => {
    const { deps, db } = await harness();
    await seedPartner(db, 'other');
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-pd-iso', txBody({ purpose: 'other', purpose_detail: 'helping a neighbour repair the roof' }));
    const id = String(view(r).id);
    expect(await getTransaction(deps, 'other', id)).toMatchObject({ ok: false, status: 404 });
    const list = await listTransactions(deps, 'other', {});
    expect(list.ok && (list.data as { transactions: unknown[] }).transactions).toEqual([]);
    const repo = createTransferRepo(db);
    expect((await repo.listPurposeDetails('other', [id])).size).toBe(0);
    expect(await repo.getPurposeDetail(id, { partnerId: 'other' })).toBeNull();
    expect((await repo.listPurposeDetails('acme', [id])).get(id)).toBe('helping a neighbour repair the roof');
  });
});
