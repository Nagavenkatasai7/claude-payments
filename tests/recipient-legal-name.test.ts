import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { createStore } from '@/lib/store';
import { createIdempotencyRepo, createRecipientRepo } from '@/db/repos/aux-repos';
import {
  fillRecipientBookLegalName,
  payLegalNameOnFile,
  writeRecipientLegalName,
} from '@/lib/recipient-legal-name';
import type { Draft, Recipient, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';

// Fix pack 4 T15 (C18, C17): the pay step's account-holder name helpers.
//   writeRecipientLegalName      fill-only write + transfer.legal_name_set, ONE transaction
//   payLegalNameOnFile           the "not needed" rule for a transfer or a draft
//   fillRecipientBookLegalName   best-effort fill of the saved recipient's empty name

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
// last4 of the repo = the last 4 DIGITS: put the IFSC first so the account's tail counts.
const ACCOUNT = 'HDFC0001234 123456789012';
const OTHER_ACCOUNT = 'HDFC0001234 123456785555';

let db: Db;
let store: ReturnType<typeof createStore>;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, OWNER, 'Acme');
  store = createStore(fakeRedis(), db);
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

async function legalNameSetRows() {
  const r = (await db.execute(
    sql`SELECT actor, actor_type, partner_id, subject_id, meta FROM audit_events WHERE action = 'transfer.legal_name_set' ORDER BY id`,
  )) as unknown as { rows: Array<{ actor: string; actor_type: string; partner_id: string; subject_id: string; meta: unknown }> };
  return r.rows;
}

const legalOf = async (id: string) => (await store.getTransferDecrypted(id))?.recipientLegalName;

describe('writeRecipientLegalName (C18 step 3, C17)', () => {
  it('writes the name and ONE transfer.legal_name_set row with ids only', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_w1' }));
    expect(await writeRecipientLegalName(db, { id: 'tr_w1', partnerId: OWNER }, 'Anita Legal')).toBe(true);
    expect(await legalOf('tr_w1')).toBe('Anita Legal');
    const rows = await legalNameSetRows();
    expect(rows).toEqual([
      { actor: 'pay-page', actor_type: 'system', partner_id: OWNER, subject_id: 'tr_w1', meta: { source: 'pay_page' } },
    ]);
  });

  it.each([
    ['a paid row', async () => store.saveTransfer(makeTransfer({ id: 'tr_g', status: 'paid' })), undefined],
    ['a partner-API row', async () => {
      await store.saveTransfer(makeTransfer({ id: 'tr_g' }));
      await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'tr_g');
    }, undefined],
    ['a row with a name already', async () => store.saveTransfer(makeTransfer({ id: 'tr_g', recipientLegalName: 'First Name' })), 'First Name'],
  ])('guard miss (%s) -> false, no audit row, name unchanged', async (_label, seed, before) => {
    await seed();
    expect(await writeRecipientLegalName(db, { id: 'tr_g', partnerId: OWNER }, 'Anita Legal')).toBe(false);
    expect(await legalNameSetRows()).toEqual([]);
    expect(await legalOf('tr_g')).toBe(before);
  });

  it('another tenant id -> false (the WHERE pins partner_id), nothing written', async () => {
    await seedPartner(db, 'other', 'Other');
    await store.saveTransfer(makeTransfer({ id: 'tr_x' }));
    expect(await writeRecipientLegalName(db, { id: 'tr_x', partnerId: 'other' }, 'Anita Legal')).toBe(false);
    expect(await legalOf('tr_x')).toBeUndefined();
    expect(await legalNameSetRows()).toEqual([]);
  });

  it('review R1-P2 D1: replace overwrites a name on the row; the audit meta says replaced (a boolean, never a name)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_r1', recipientLegalName: 'Old Holder' }));
    expect(await writeRecipientLegalName(db, { id: 'tr_r1', partnerId: OWNER }, 'Anita Legal', { replace: true })).toBe(true);
    expect(await legalOf('tr_r1')).toBe('Anita Legal');
    await store.saveTransfer(makeTransfer({ id: 'tr_r2' }));
    expect(await writeRecipientLegalName(db, { id: 'tr_r2', partnerId: OWNER }, 'Anita Legal', { replace: true })).toBe(true);
    expect((await legalNameSetRows()).map((r) => [r.subject_id, r.meta])).toEqual([
      ['tr_r1', { source: 'pay_page', replaced: true }],
      ['tr_r2', { source: 'pay_page' }],
    ]);
  });

  it('an audit insert that fails -> throws and the name is NOT written (one transaction)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_fail' }));
    await db.execute(sql.raw(`CREATE FUNCTION fail_legal_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'legal-audit-fail'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_legal_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'transfer.legal_name_set') EXECUTE FUNCTION fail_legal_audit()`));
    // freshDb truncates tables but keeps triggers: drop it for the next test.
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_legal_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_legal_audit()'));
    });
    await expect(writeRecipientLegalName(db, { id: 'tr_fail', partnerId: OWNER }, 'Anita Legal')).rejects.toThrow();
    expect(await legalOf('tr_fail')).toBeUndefined();
    expect(await legalNameSetRows()).toEqual([]);
  });
});

describe('payLegalNameOnFile (C18 "not needed" rule)', () => {
  it('a transfer without a name -> false; with a name -> true', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_none' }));
    await store.saveTransfer(makeTransfer({ id: 'tr_has', recipientLegalName: 'Anita Legal' }));
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_none', partnerId: OWNER } })).toBe(false);
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_has', partnerId: OWNER } })).toBe(true);
  });

  it('a Partner-API-minted or payment-link transfer without a name -> true (exempt)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_api' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'tr_api');
    await store.saveTransfer(makeTransfer({ id: 'tr_link' }));
    await createIdempotencyRepo(db).claim(OWNER, 'paylink:lnk_1', 'tr_link');
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_api', partnerId: OWNER } })).toBe(true);
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_link', partnerId: OWNER } })).toBe(true);
  });

  it('a b2b transfer and a b2b draft -> true', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_b2b', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }));
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_b2b', partnerId: OWNER } })).toBe(true);
    expect(await payLegalNameOnFile(db, { draft: makeDraft({ transferType: 'b2b' }), ownerId: OWNER, newBankFields: false })).toBe(true);
  });

  it('a draft with its own legal name -> true; with new bank fields -> false (review R1-P2 D1: it describes the stored account)', async () => {
    const draft = makeDraft({ recipientLegalName: 'Draft Legal' });
    expect(await payLegalNameOnFile(db, { draft, ownerId: OWNER, newBankFields: false })).toBe(true);
    expect(await payLegalNameOnFile(db, { draft, ownerId: OWNER, newBankFields: true })).toBe(false);
  });

  it('review R1-P2 D1: a transfer posting new bank fields -> a name on the row does not count; an exempt row still does', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tr_has', recipientLegalName: 'Anita Legal' }));
    await store.saveTransfer(makeTransfer({ id: 'tr_api' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'tr_api');
    await store.saveTransfer(makeTransfer({ id: 'tr_link' }));
    await createIdempotencyRepo(db).claim(OWNER, 'paylink:lnk_1', 'tr_link');
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_has', partnerId: OWNER }, newBankFields: true })).toBe(false);
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_has', partnerId: OWNER }, newBankFields: false })).toBe(true);
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_api', partnerId: OWNER }, newBankFields: true })).toBe(true);
    expect(await payLegalNameOnFile(db, { transfer: { id: 'tr_link', partnerId: OWNER }, newBankFields: true })).toBe(true);
  });

  it('a draft whose saved recipient has a name for the SAME account -> true; for another account -> false', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: 'Book Legal' });
    expect(await payLegalNameOnFile(db, { draft: makeDraft(), ownerId: OWNER, newBankFields: false })).toBe(true);
    const other = makeDraft({ recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: OTHER_ACCOUNT } });
    expect(await payLegalNameOnFile(db, { draft: other, ownerId: OWNER, newBankFields: false })).toBe(false);
  });

  it('a draft posting new bank fields -> only its own name counts (the book name is not read)', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: 'Book Legal' });
    expect(await payLegalNameOnFile(db, { draft: makeDraft(), ownerId: OWNER, newBankFields: true })).toBe(false);
  });

  it('a draft with no recipient field (route mocks) -> false, never throws', async () => {
    const draft = { senderPhone: SENDER, amountUsd: 1 } as unknown as Draft;
    expect(await payLegalNameOnFile(db, { draft, ownerId: OWNER, newBankFields: false })).toBe(false);
  });

  it('a book read that throws -> false, one warn with ids only', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: 'Book Legal' });
    // A ciphertext sealed for another column fails its AAD check, so the decrypting read throws.
    await db.execute(sql`UPDATE recipients SET legal_name_enc = payout_destination_enc`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await payLegalNameOnFile(db, { draft: makeDraft(), ownerId: OWNER, newBankFields: false })).toBe(false);
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('pay.legal_name_read'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/book legal|mom/i);
    expect(lines[0]).not.toContain(SENDER);
    expect(lines[0]).not.toContain(RP);
  });
});

describe('fillRecipientBookLegalName (C18 step 6)', () => {
  const t = { id: 'tr_book', partnerId: OWNER, phone: SENDER, recipientPhone: RP };
  // Review R1-P2 D2/E1/F1: the account that was paid (raw values, never a mask).
  const PAID = { payoutMethod: 'bank' as const, payoutDestination: ACCOUNT };
  const bookName = () => createRecipientRepo(db).getRecipientLegalName(OWNER, SENDER, RP);

  it('fills an empty live book row', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec());
    await fillRecipientBookLegalName(db, t, 'Anita Legal', PAID);
    expect(await bookName()).toBe('Anita Legal');
  });

  it('review R1-P2 D2: never fills a book row that holds ANOTHER account than the one paid', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec());
    await fillRecipientBookLegalName(db, t, 'Anita Legal', { payoutMethod: 'bank', payoutDestination: OTHER_ACCOUNT });
    expect(await bookName()).toBeNull();
  });

  it('never overwrites a saved name', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec(), { legalName: 'Saved Legal' });
    await fillRecipientBookLegalName(db, t, 'Anita Legal', PAID);
    expect(await bookName()).toBe('Saved Legal');
  });

  it('never un-deletes a tombstoned row', async () => {
    await createRecipientRepo(db).upsertRecipient(OWNER, SENDER, rec());
    await createRecipientRepo(db).tombstoneRecipient(OWNER, SENDER, RP);
    await fillRecipientBookLegalName(db, t, 'Anita Legal', PAID);
    expect(await bookName()).toBeNull();
    expect(await createRecipientRepo(db).listRecipients(OWNER, SENDER, 10)).toEqual([]);
    const raw = (await db.execute(sql`SELECT legal_name_enc FROM recipients`)) as unknown as { rows: Array<{ legal_name_enc: string | null }> };
    expect(raw.rows.map((r) => r.legal_name_enc)).toEqual([null]);
  });

  it('a throwing repo is swallowed with one warn carrying ids only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      update: () => { throw new TypeError('db down'); },
      select: () => { throw new TypeError('db down'); },
    } as unknown as DbOrTx;
    await expect(fillRecipientBookLegalName(broken, t, 'Anita Legal', PAID)).resolves.toBeUndefined();
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('pay.legal_name_book'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tr_book');
    expect(lines[0]).toContain('TypeError');
    expect(lines[0]).not.toMatch(/anita|db down/i);
    expect(lines[0]).not.toContain(SENDER);
    expect(lines[0]).not.toContain(RP);
  });
});
