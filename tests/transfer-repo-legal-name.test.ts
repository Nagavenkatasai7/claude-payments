import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTransferRepo, type TransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo, createIdempotencyRepo } from '@/db/repos/aux-repos';
import { transfers } from '@/db/schema';
import { EnvKeyProvider, decryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { DisclosureSnapshotV1 } from '@/lib/remittance-disclosure';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 4 (C4): the transfer-repo functions the pay step calls later (T8, T14, T15):
// the fill-only account-holder name, the identity-missing test, the disclosure snapshot
// writer and reader, and saveTransfer's fill-or-keep of the legal name (critic P14).

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const NAME = 'Anita Legal';

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
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
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

const snapshot = (over: Partial<DisclosureSnapshotV1> = {}): DisclosureSnapshotV1 => ({
  v: 1,
  version: 'draft-test',
  configHash: 'cfg-hash',
  shownHash: null,
  figures: {
    amountSource: 200, feeSource: 1.99, totalChargeSource: 201.99, sourceCurrency: 'USD',
    amountDest: 17040, destinationCurrency: 'INR', fxRate: 85.2,
  },
  provider: {
    kind: 'configured', licensedEntity: 'Acme Money Services LLC', licenceIds: ['NMLS 000000'],
    phone: null, website: null, regulator: 'State Dept', approved: true,
  },
  deliveryBusinessDays: 2,
  dateAvailable: 'within 2 business days',
  acknowledgedAt: new Date(Date.now() - 60_000).toISOString(),
  surface: 'transfer',
  ...over,
});

const throwingProvider: EncryptionKeyProvider = {
  wrapDataKey: () => { throw new Error('no wrap'); },
  unwrapDataKey: () => { throw new Error('no unwrap'); },
};

let db: Db;
let repo: TransferRepo;
beforeEach(async () => {
  db = await freshDb();
  repo = createTransferRepo(db, provider);
});

async function rawLegal(id: string): Promise<string | null | undefined> {
  const rows = await db.select({ v: transfers.recipientLegalNameEnc }).from(transfers).where(eq(transfers.id, id));
  return rows[0]?.v;
}

describe('setRecipientLegalNameIfEditable', () => {
  it('seals under ctx.transfer(id, recipient_legal_name_enc); the decrypted read returns it; true', async () => {
    await repo.saveTransfer(fixture());
    expect(await repo.setRecipientLegalNameIfEditable('tr_1', 'default', `  ${NAME} `)).toBe(true);
    const raw = await rawLegal('tr_1');
    expect(raw).toMatch(/^v2\.k0\./);
    expect(raw).not.toContain(NAME);
    expect(decryptField(raw!, provider, ctx.transfer('tr_1', 'recipient_legal_name_enc'))).toBe(NAME);
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe(NAME);
    expect((await repo.getTransfer('tr_1'))?.recipientLegalName).toBeUndefined();
  });

  it('is fill-only: a second call with another name returns false and the first name stays', async () => {
    await repo.saveTransfer(fixture());
    expect(await repo.setRecipientLegalNameIfEditable('tr_1', 'default', NAME)).toBe(true);
    expect(await repo.setRecipientLegalNameIfEditable('tr_1', 'default', 'Someone Else')).toBe(false);
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe(NAME);
  });

  it('a blank name is false and writes nothing', async () => {
    await repo.saveTransfer(fixture());
    expect(await repo.setRecipientLegalNameIfEditable('tr_1', 'default', '   ')).toBe(false);
    expect(await rawLegal('tr_1')).toBeNull();
  });

  it('refused (false, nothing written) for paid, in_review, charged, b2b, another tenant, a partner-API row, a payment-link row', async () => {
    await seedPartner(db, 'acme');
    const cases: Array<[string, Partial<Transfer>]> = [
      ['n_paid', { status: 'paid' }],
      ['n_review', { status: 'in_review' }],
      ['n_charged', { fundingRef: 'mockfund-n_charged' }],
      ['n_b2b', { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }],
      ['n_acme', { partnerId: 'acme' }],
      ['n_api', {}],
      ['n_api_audit', {}],
      ['n_link', {}],
    ];
    for (const [id, over] of cases) await repo.saveTransfer(fixture({ id, ...over }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'n_api');
    await createAuditRepo(db).record({ partnerId: 'default', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'n_api_audit' });
    await createIdempotencyRepo(db).claim('default', 'paylink:l_1', 'n_link');
    for (const [id] of cases) {
      expect(await repo.setRecipientLegalNameIfEditable(id, 'default', NAME), id).toBe(false);
      expect(await rawLegal(id), id).toBeNull();
    }
    expect(await repo.setRecipientLegalNameIfEditable('missing', 'default', NAME)).toBe(false);
  });
});

describe('recipientIdentityMissing', () => {
  it('true for a b2c row with no name; false once it has one', async () => {
    await repo.saveTransfer(fixture());
    expect(await repo.recipientIdentityMissing('tr_1', 'default')).toBe(true);
    await repo.setRecipientLegalNameIfEditable('tr_1', 'default', NAME);
    expect(await repo.recipientIdentityMissing('tr_1', 'default')).toBe(false);
  });

  it('false for b2b, a partner-API row (claim or api_key audit), a payment-link row, another tenant and a missing id', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'm_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }));
    await repo.saveTransfer(fixture({ id: 'm_api' }));
    await repo.saveTransfer(fixture({ id: 'm_api_audit' }));
    await repo.saveTransfer(fixture({ id: 'm_link' }));
    await repo.saveTransfer(fixture({ id: 'm_acme', partnerId: 'acme' }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'm_api');
    await createAuditRepo(db).record({ partnerId: 'default', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'm_api_audit' });
    await createIdempotencyRepo(db).claim('default', 'paylink:l_1', 'm_link');
    for (const id of ['m_b2b', 'm_api', 'm_api_audit', 'm_link', 'm_acme', 'missing']) {
      expect(await repo.recipientIdentityMissing(id, 'default'), id).toBe(false);
    }
    expect(await repo.recipientIdentityMissing('m_acme', 'acme')).toBe(true);
  });

  it('a draft or schedule claim does not exempt the row', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'm_draft' }));
    await repo.saveTransfer(fixture({ id: 'm_sched', partnerId: 'acme' }));
    await createIdempotencyRepo(db).claim('default', 'draft:d_1', 'm_draft');
    await createIdempotencyRepo(db).claim('acme', 'sched:s_1:day', 'm_sched');
    expect(await repo.recipientIdentityMissing('m_draft', 'default')).toBe(true);
    expect(await repo.recipientIdentityMissing('m_sched', 'acme')).toBe(true);
  });

  it('never decrypts (a provider that throws on unwrap stays unused)', async () => {
    await repo.saveTransfer(fixture({ id: 'm_named', recipientLegalName: NAME }));
    await repo.saveTransfer(fixture({ id: 'm_empty' }));
    const blind = createTransferRepo(db, throwingProvider);
    expect(await blind.recipientIdentityMissing('m_named', 'default')).toBe(false);
    expect(await blind.recipientIdentityMissing('m_empty', 'default')).toBe(true);
  });
});

describe('disclosure snapshot', () => {
  it('setDisclosureSnapshotIfAwaiting writes only while awaiting_payment and in tenant, and overwrites a previous snapshot', async () => {
    await repo.saveTransfer(fixture());
    const first = snapshot();
    expect(await repo.setDisclosureSnapshotIfAwaiting('tr_1', 'default', first)).toBe(true);
    expect(await repo.getDisclosureSnapshot('tr_1', 'default')).toEqual(first);
    const second = snapshot({ version: 'draft-test-2', surface: 'link', deliveryBusinessDays: 0 });
    expect(await repo.setDisclosureSnapshotIfAwaiting('tr_1', 'default', second)).toBe(true);
    expect(await repo.getDisclosureSnapshot('tr_1', 'default')).toEqual(second);
  });

  it('returns false and writes nothing for paid / in_review / another tenant / a missing row', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 's_paid', status: 'paid' }));
    await repo.saveTransfer(fixture({ id: 's_review', status: 'in_review' }));
    await repo.saveTransfer(fixture({ id: 's_acme', partnerId: 'acme' }));
    for (const id of ['s_paid', 's_review', 's_acme', 'missing']) {
      expect(await repo.setDisclosureSnapshotIfAwaiting(id, 'default', snapshot()), id).toBe(false);
    }
    const rows = await db.select({ id: transfers.id, s: transfers.disclosureSnapshot }).from(transfers);
    for (const r of rows) expect(r.s, r.id).toBeNull();
  });

  it('getDisclosureSnapshot: null for another tenant, a missing row, a NULL column and a malformed stored value', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture());
    expect(await repo.getDisclosureSnapshot('tr_1', 'default')).toBeNull(); // NULL column
    await repo.setDisclosureSnapshotIfAwaiting('tr_1', 'default', snapshot());
    expect(await repo.getDisclosureSnapshot('tr_1', 'acme')).toBeNull();
    expect(await repo.getDisclosureSnapshot('missing', 'default')).toBeNull();
    await db.update(transfers).set({ disclosureSnapshot: { v: 1, version: 'x' } }).where(eq(transfers.id, 'tr_1'));
    expect(await repo.getDisclosureSnapshot('tr_1', 'default')).toBeNull();
  });

  it('saveTransfer read-modify-write never touches disclosure_snapshot', async () => {
    await repo.saveTransfer(fixture());
    const snap = snapshot();
    await repo.setDisclosureSnapshotIfAwaiting('tr_1', 'default', snap);
    await repo.saveTransfer((await repo.getTransfer('tr_1'))!);
    await repo.saveTransfer({ ...(await repo.getTransfer('tr_1', { decrypt: true }))!, status: 'paid' });
    expect(await repo.getDisclosureSnapshot('tr_1', 'default')).toEqual(snap);
  });
});

describe('saveTransfer keeps the legal name (fill-or-keep, critic P14)', () => {
  it('a masked read-modify-write of an EMPTY-destination row keeps recipient_legal_name_enc', async () => {
    await repo.saveTransfer(fixture({ payoutDestination: '' }));
    expect(await repo.setRecipientLegalNameIfEditable('tr_1', 'default', NAME)).toBe(true);
    const masked = (await repo.getTransfer('tr_1'))!;
    expect(masked.payoutDestination).toBe(''); // not '****'-prefixed: the mask guard does not engage
    await repo.saveTransfer(masked);
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe(NAME);
  });

  it('a decrypted read-modify-write without a name keeps it too', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: NAME }));
    const t = (await repo.getTransfer('tr_1', { decrypt: true }))!;
    delete t.recipientLegalName;
    await repo.saveTransfer(t);
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe(NAME);
  });

  it('a decrypted save with a recipientLegalName still writes it (insert and conflict)', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: NAME }));
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe(NAME);
    const t = (await repo.getTransfer('tr_1', { decrypt: true }))!;
    await repo.saveTransfer({ ...t, recipientLegalName: 'Corrected Name' });
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe('Corrected Name');
  });
});

// Review R3-X1 N1 (decision D3): the name typed next to NEW bank details is written in the
// same guarded UPDATE as the payout (setPayoutIfEditable legalName); the clear decision is
// made under the row lock (lockEditablePayout), never derived in SQL.
describe('lockEditablePayout (review R3-X1 N1)', () => {
  it('returns the decrypted stored destination and whether a name is on the row; null when the payout guard refuses', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ recipientLegalName: 'Old Holder' }));
    const full = await repo.getTransfer('tr_1', { decrypt: true });
    expect(await repo.lockEditablePayout('tr_1', 'default')).toEqual({ storedDestination: full!.payoutDestination, hasLegalName: true });
    await repo.saveTransfer(fixture({ id: 'l_empty', payoutDestination: '' }));
    expect(await repo.lockEditablePayout('l_empty', 'default')).toEqual({ storedDestination: '', hasLegalName: false });
    await repo.saveTransfer(fixture({ id: 'l_paid', status: 'paid' }));
    await repo.saveTransfer(fixture({ id: 'l_api' }));
    await createIdempotencyRepo(db).claim('default', 'order-9', 'l_api');
    for (const id of ['l_paid', 'l_api', 'missing']) expect(await repo.lockEditablePayout(id, 'default'), id).toBeNull();
    expect(await repo.lockEditablePayout('tr_1', 'acme')).toBeNull();
  });
});

describe('recipientIdentityExempt (review R1-P2 D1)', () => {
  it('true for b2b, a partner-API row and a payment-link row; false for a plain b2c row, another tenant, a missing id', async () => {
    await seedPartner(db, 'acme');
    await repo.saveTransfer(fixture({ id: 'x_plain', recipientLegalName: NAME }));
    await repo.saveTransfer(fixture({ id: 'x_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }));
    await repo.saveTransfer(fixture({ id: 'x_api' }));
    await repo.saveTransfer(fixture({ id: 'x_link' }));
    await createIdempotencyRepo(db).claim('default', 'order-1', 'x_api');
    await createIdempotencyRepo(db).claim('default', 'paylink:l_1', 'x_link');
    expect(await repo.recipientIdentityExempt('x_plain', 'default')).toBe(false);
    for (const id of ['x_b2b', 'x_api', 'x_link']) expect(await repo.recipientIdentityExempt(id, 'default'), id).toBe(true);
    expect(await repo.recipientIdentityExempt('x_api', 'acme')).toBe(false);
    expect(await repo.recipientIdentityExempt('missing', 'default')).toBe(false);
  });
});

describe('setPayoutIfEditable legalName / clearLegalName (review R3-X1 N1, N2)', () => {
  const NEW = { payoutMethod: 'bank' as const, payoutDestination: '987654321098 SBIN0005678' };

  it('legalName: the payout and the sealed name in ONE update (a name on the row is replaced)', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Old Holder' }));
    expect(await repo.setPayoutIfEditable('tr_1', 'default', NEW, { legalName: ` ${NAME} ` })).not.toBeNull();
    const full = await repo.getTransfer('tr_1', { decrypt: true });
    expect(full?.payoutDestination).toBe(NEW.payoutDestination);
    expect(full?.recipientLegalName).toBe(NAME);
    expect(decryptField((await rawLegal('tr_1'))!, provider, ctx.transfer('tr_1', 'recipient_legal_name_enc'))).toBe(NAME);
  });

  it('a guard miss writes neither the payout nor the name', async () => {
    await repo.saveTransfer(fixture({ status: 'paid', recipientLegalName: 'Old Holder' }));
    const before = await repo.getTransfer('tr_1', { decrypt: true });
    expect(await repo.setPayoutIfEditable('tr_1', 'default', NEW, { legalName: NAME })).toBeNull();
    const after = await repo.getTransfer('tr_1', { decrypt: true });
    expect(after?.payoutDestination).toBe(before?.payoutDestination);
    expect(after?.recipientLegalName).toBe('Old Holder');
  });

  it('clearLegalName (no name typed): the old name is cleared in the same write', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Old Holder' }));
    expect(await repo.setPayoutIfEditable('tr_1', 'default', NEW, { clearLegalName: true })).not.toBeNull();
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.payoutDestination).toBe(NEW.payoutDestination);
    expect(await rawLegal('tr_1')).toBeNull();
  });

  it('clearLegalName false, or no option (every other caller): the name survives', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Old Holder' }));
    expect(await repo.setPayoutIfEditable('tr_1', 'default', NEW, { clearLegalName: false })).not.toBeNull();
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe('Old Holder');
    expect(await repo.setPayoutIfEditable('tr_1', 'default', NEW)).not.toBeNull();
    expect((await repo.getTransfer('tr_1', { decrypt: true }))?.recipientLegalName).toBe('Old Holder');
  });
});
