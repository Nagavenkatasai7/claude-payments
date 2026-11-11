import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Db } from '@/db/client';
import { createStore } from '@/lib/store';
import { createIdempotencyRepo, createRecipientRepo } from '@/db/repos/aux-repos';
import { readLegalNameView } from '@/lib/recipient-legal-name';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { Draft, Recipient, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { setRailProviderType } from './helpers-sanctions';

// Fix pack 4 T16 (C18, C12): the pay PAGE's view of the account-holder field.
// readLegalNameView answers only two booleans (never a stored name):
//   legalNameRequired  'required WHEN SHOWN' = real money for the field and not exempt
//   legalNameOnFile    C18's "not needed" rule for the stored account

const fault = vi.hoisted(() => ({ railReadThrows: false, apiMintedThrows: false }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const repo = real.createIntegrationsRepo(...a);
      return fault.railReadThrows
        ? { ...repo, paymentProviderType: async () => { throw new TypeError('rail read down'); } }
        : repo;
    },
  };
});
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const repo = real.createTransferRepo(...a);
      return fault.apiMintedThrows
        ? { ...repo, isPartnerApiMinted: async () => { throw new RangeError('ledger down'); } }
        : repo;
    },
  };
});

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
// The repo's last4 is the last 4 DIGITS: put the IFSC first so the account's tail counts.
const ACCOUNT = 'HDFC0001234 123456789012';
const OTHER_ACCOUNT = 'HDFC0001234 123456785555';
const STORED_NAME = 'Zq Marker Legalname';

let db: Db;
let store: ReturnType<typeof createStore>;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, OWNER, 'Acme');
  store = createStore(fakeRedis(), db);
  fault.railReadThrows = false;
  fault.apiMintedThrows = false;
});
afterEach(() => vi.restoreAllMocks());

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: RP,
    payoutMethod: 'bank', payoutDestination: ACCOUNT, fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: OWNER,
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

function makeDraft(o: Partial<Draft> = {}): Draft {
  return {
    senderPhone: SENDER,
    partnerId: OWNER,
    recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT },
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    ...o,
  } as Draft;
}

const rec = (o: Partial<Recipient> = {}): Recipient => ({
  name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT,
  lastUsedAt: new Date().toISOString(), ...o,
});

const transferView = (t: Pick<Transfer, 'id' | 'partnerId'>, transferType: 'b2c' | 'b2b' = 'b2c') =>
  readLegalNameView(db, { ownerId: t.partnerId, railPartnerId: t.partnerId, environment: 'live', transferType, transfer: t });

const draftView = (draft: Draft, ownerId = OWNER) =>
  readLegalNameView(db, {
    ownerId,
    railPartnerId: draft.settlementPartnerId ?? ownerId,
    environment: undefined,
    transferType: draft.transferType ?? 'b2c',
    draft,
  });

describe('readLegalNameView: a minted transfer (C18)', () => {
  it('b2c transfer, owner on an http rail, no name -> required, not on file', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await store.saveTransfer(makeTransfer({ id: 'tr_v1' }));
    expect(await transferView({ id: 'tr_v1', partnerId: OWNER })).toEqual({ legalNameRequired: true, legalNameOnFile: false });
  });

  it('b2c transfer with recipient_legal_name_enc set -> on file, required still true (required = when shown)', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await store.saveTransfer(makeTransfer({ id: 'tr_v2' }));
    const { createTransferRepo } = await import('@/db/repos/transfer-repo');
    expect(await createTransferRepo(db).setRecipientLegalNameIfEditable('tr_v2', OWNER, STORED_NAME)).toBe(true);
    expect(await transferView({ id: 'tr_v2', partnerId: OWNER })).toEqual({ legalNameRequired: true, legalNameOnFile: true });
  });

  it('a Partner-API-minted real-money b2c transfer with no name -> exempt, never asked (critic M1)', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await store.saveTransfer(makeTransfer({ id: 'tr_api' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'tr_api');
    expect(await transferView({ id: 'tr_api', partnerId: OWNER })).toEqual({ legalNameRequired: false, legalNameOnFile: true });
  });

  it('a payment-link transfer -> exempt, never asked', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await store.saveTransfer(makeTransfer({ id: 'tr_link' }));
    await createIdempotencyRepo(db).claim(OWNER, 'paylink:lnk_1', 'tr_link');
    expect(await transferView({ id: 'tr_link', partnerId: OWNER })).toEqual({ legalNameRequired: false, legalNameOnFile: true });
  });

  it('default owner on the mock rail -> required false', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_def', partnerId: DEFAULT_PARTNER_ID }));
    expect(await transferView({ id: 'tr_def', partnerId: DEFAULT_PARTNER_ID })).toEqual({
      legalNameRequired: false,
      legalNameOnFile: false,
    });
  });

  it('a non-default owner on a simulator / mock rail -> optional', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_mock' }));
    expect((await transferView({ id: 'tr_mock', partnerId: OWNER })).legalNameRequired).toBe(false);
  });

  it('non-default owner, rail type read fails (integrations repo throws) -> required true (fail closed for the field only)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_rf' }));
    fault.railReadThrows = true;
    expect(await transferView({ id: 'tr_rf', partnerId: OWNER })).toEqual({ legalNameRequired: true, legalNameOnFile: false });
  });

  it('default owner, rail read fails -> required false (critic M3)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_drf', partnerId: DEFAULT_PARTNER_ID }));
    fault.railReadThrows = true;
    expect((await transferView({ id: 'tr_drf', partnerId: DEFAULT_PARTNER_ID })).legalNameRequired).toBe(false);
  });

  it('b2b -> required false and on file true, with no read', async () => {
    fault.railReadThrows = true;
    fault.apiMintedThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await transferView({ id: 'tr_b2b', partnerId: OWNER }, 'b2b')).toEqual({
      legalNameRequired: false,
      legalNameOnFile: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('readLegalNameView: a draft (C18)', () => {
  it('draft.recipientLegalName set -> on file', async () => {
    expect((await draftView(makeDraft({ recipientLegalName: STORED_NAME }))).legalNameOnFile).toBe(true);
  });

  it('a saved book name for (owner, sender, recipient) and the draft stored account -> on file', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: STORED_NAME });
    expect((await draftView(makeDraft())).legalNameOnFile).toBe(true);
  });

  it('a book name for another account -> not on file', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec({ payoutDestination: OTHER_ACCOUNT }), {
      legalName: STORED_NAME,
    });
    expect((await draftView(makeDraft())).legalNameOnFile).toBe(false);
  });

  it('none -> not on file; required on an http rail', async () => {
    await setRailProviderType(db, OWNER, 'http');
    expect(await draftView(makeDraft())).toEqual({ legalNameRequired: true, legalNameOnFile: false });
  });

  it('the rail is the draft settlement partner (simulator rail of the routed partner -> optional)', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await seedPartner(db, 'railp', 'Rail P');
    await setRailProviderType(db, 'railp', 'simulator');
    expect((await draftView(makeDraft({ settlementPartnerId: 'railp' }))).legalNameRequired).toBe(false);
  });

  it('a draft without a recipient field -> not on file, never throws', async () => {
    const draft = makeDraft();
    delete (draft as Partial<Draft>).recipient;
    expect((await draftView(draft)).legalNameOnFile).toBe(false);
  });

  it('a b2b draft -> required false, on file true', async () => {
    await setRailProviderType(db, OWNER, 'http');
    expect(await draftView(makeDraft({ transferType: 'b2b' }))).toEqual({ legalNameRequired: false, legalNameOnFile: true });
  });
});

describe('readLegalNameView: failures and the shape', () => {
  it('any read throws -> on file false, required from realMoneyForField, never throws; the log carries ids and the error name only', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await store.saveTransfer(makeTransfer({ id: 'tr_thr' }));
    fault.apiMintedThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await transferView({ id: 'tr_thr', partnerId: OWNER })).toEqual({ legalNameRequired: true, legalNameOnFile: false });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('pay.page-legal-name'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.msg).toBe('RangeError');
    expect(parsed.transferId).toBe('tr_thr');
    expect(parsed.partnerId).toBe(OWNER);
    for (const l of lines) {
      expect(l).not.toContain('ledger down');
      expect(l).not.toContain(SENDER);
      expect(l).not.toContain(RP);
    }
  });

  it('a draft whose book read throws -> on file false (never throws)', async () => {
    await setRailProviderType(db, OWNER, 'http');
    const broken = makeDraft();
    // A recipient phone getter that throws simulates an unexpected read failure.
    Object.defineProperty(broken.recipient, 'recipientPhone', { get: () => { throw new TypeError('bad draft'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await draftView(broken)).toEqual({ legalNameRequired: true, legalNameOnFile: false });
  });

  it('the result has exactly the two boolean keys: no name ever leaves the helper', async () => {
    await setRailProviderType(db, OWNER, 'http');
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: STORED_NAME });
    await store.saveTransfer(makeTransfer({ id: 'tr_keys' }));
    for (const r of [
      await draftView(makeDraft({ recipientLegalName: STORED_NAME })),
      await draftView(makeDraft()),
      await transferView({ id: 'tr_keys', partnerId: OWNER }),
      await transferView({ id: 'tr_keys', partnerId: OWNER }, 'b2b'),
    ]) {
      expect(Object.keys(r).sort()).toEqual(['legalNameOnFile', 'legalNameRequired']);
      expect(typeof r.legalNameOnFile).toBe('boolean');
      expect(typeof r.legalNameRequired).toBe('boolean');
      expect(JSON.stringify(r)).not.toContain(STORED_NAME);
    }
  });
});
