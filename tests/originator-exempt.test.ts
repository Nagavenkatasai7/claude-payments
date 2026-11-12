/**
 * Fix pack 5 T20a (R38, P22): which real-money rows are exempt from the travel
 * rule's originator data. B2B rows and Partner-API-minted rows are exempt (the
 * partner attests its own sender); pay-page draft mints of a non-default
 * partner (their claim is 'draft:<id>' under the DEFAULT tenant, the
 * pay-finalize shape), cron mints ('sched:<id>:<day>') and payment-link mints
 * ('paylink:<id>', which partnerApiMintedSql also matches) are NOT.
 * Tenant-scoped: another tenant's id reads false.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo, createIdempotencyRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { PartnerId, Transfer } from '@/lib/types';

const ACME = 'acme' as PartnerId;

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'ox_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: ACME, environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205, transferType: 'b2c',
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

async function row(id: string, over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = fixture({ id, ...over });
  await store.saveTransfer(t);
  return t;
}

const exempt = (id: string, partnerId: PartnerId = ACME) => createTransferRepo(db).originatorExempt(id, partnerId);

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
});

describe('originatorExempt (P22)', () => {
  // The red pin, written first: none of these may read exempt.
  it("NOT exempt: a non-default partner's pay-page draft mint, a cron mint and a payment-link mint", async () => {
    const draft = await row('ox_draft');
    await createIdempotencyRepo(db).claim(DEFAULT_PARTNER_ID, 'draft:d_1', draft.id);
    const cron = await row('ox_cron');
    await createIdempotencyRepo(db).claim(ACME, 'sched:s_1:2026-01-01', cron.id);
    const link = await row('ox_link');
    await createIdempotencyRepo(db).claim(ACME, 'paylink:l_1', link.id);
    expect(await exempt(draft.id)).toBe(false);
    expect(await exempt(cron.id)).toBe(false);
    expect(await exempt(link.id)).toBe(false);
  });

  it('NOT exempt: a plain b2c row with no claim and no api_key audit', async () => {
    await row('ox_plain');
    expect(await exempt('ox_plain')).toBe(false);
  });

  it('exempt: a b2b row', async () => {
    await row('ox_b2b', { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' } as Partial<Transfer>);
    expect(await exempt('ox_b2b')).toBe(true);
  });

  it('exempt: a Partner-API-minted row (a non-draft idempotency claim)', async () => {
    await row('ox_api');
    await createIdempotencyRepo(db).claim(ACME, 'order-1', 'ox_api');
    expect(await exempt('ox_api')).toBe(true);
  });

  it("exempt: a Partner-API-minted row (an api_key 'transaction.create' audit row)", async () => {
    await row('ox_api_audit');
    await createAuditRepo(db).record({ partnerId: ACME, actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'ox_api_audit' });
    expect(await exempt('ox_api_audit')).toBe(true);
  });

  it('a missing row: false', async () => {
    expect(await exempt('ox_none')).toBe(false);
  });

  it("another tenant's id: false (tenant-scoped)", async () => {
    await row('ox_b2b_acme', { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' } as Partial<Transfer>);
    expect(await exempt('ox_b2b_acme', 'beta' as PartnerId)).toBe(false);
  });
});
