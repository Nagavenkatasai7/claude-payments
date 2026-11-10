/**
 * Fix pack 4 T15 (C18, C17, R03): the pay route captures the recipient's
 * account-holder name BEFORE the pay-time re-screen.
 *   - real money, no name on file: the key is required (absent -> 409 reload,
 *     '' or invalid -> 400), answered before the code is checked;
 *   - a typed valid name is written fill-only with its transfer.legal_name_set
 *     row in ONE transaction, then the re-screen covers it (chat + legal);
 *   - a name already on file is never replaced; exempt rows are never asked;
 *   - after a 2xx the saved recipient's EMPTY book entry is filled;
 *   - the default tenant (not real money) makes no new read for an old tab.
 * The typed name never reaches a log line (checked over the whole file).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { okVerify, realMoneyPayBody } from './helpers-pay-evidence';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { createIdempotencyRepo, createRecipientRepo } from '@/db/repos/aux-repos';
import { PAY_ACCOUNT_HOLDER_COPY, PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';
import { RECIPIENT_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import type { Draft, Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));
const otp = vi.hoisted(() => ({ verify: null as unknown as ReturnType<typeof import('vitest').vi.fn> }));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: (...a: unknown[]) => otp.verify(...a),
  }),
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let draftStore: ReturnType<typeof createDraftStore>;
vi.mock('@/lib/draft-store', async (orig) => {
  const real = await orig<typeof import('@/lib/draft-store')>();
  return { ...real, getDraftStore: () => draftStore };
});
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
const rails = vi.hoisted(() => ({ byPartner: {} as Record<string, PartnerIntegrations['payment']> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, payment: rails.byPartner[id] ?? {}, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
// Faults: the guarded write misses, the book fill throws, the gate context's rail read fails once.
const fault = vi.hoisted(() => ({ guardMiss: false, bookThrows: false, railReadFailNext: false }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const repo = real.createTransferRepo(...a);
      return fault.guardMiss ? { ...repo, setRecipientLegalNameIfEditable: async () => false } : repo;
    },
  };
});
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createRecipientRepo: (...a: Parameters<typeof real.createRecipientRepo>) => {
      const repo = real.createRecipientRepo(...a);
      return fault.bookThrows
        ? { ...repo, fillRecipientLegalName: async () => { throw new TypeError('book down'); } }
        : repo;
    },
  };
});
vi.mock('@/lib/live-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/live-gate')>();
  return {
    ...real,
    readRailProviderType: async (...a: Parameters<typeof real.readRailProviderType>) => {
      if (fault.railReadFailNext) {
        fault.railReadFailNext = false;
        return undefined; // a failed read (readRailProviderType never throws)
      }
      return real.readRailProviderType(...a);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const OWNER = 'acme';
const SENDER = '15551234567';
const RP = '919876543210';
const ACCOUNT = '123456789012|HDFC0001234';
// The repo's last4 is the last 4 DIGITS of the string: vary the tail for "another account".
const OTHER_ACCOUNT = '123456789012|HDFC0005555';
const H = 3_600_000;
const HTTP_RAIL: PartnerIntegrations['payment'] = {
  providerType: 'http',
  credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
};
const TYPED = 'Typed Holder';
const ERROR_400 = { ok: false, error: 'Please check the account holder name.', fieldErrors: { accountHolder: PAY_ACCOUNT_HOLDER_COPY } };

// Every console line of the file: the typed names and the phones must never appear.
const consoleLines: string[] = [];
const PII = ['Typed Holder', 'Anita Legal', 'Testa Fixturelli', 'Draft Legal', 'Other Book', SENDER, RP];

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

function post(id: string, body: unknown) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

/** The real-money body WITHOUT the accountHolder key (an old tab). */
function noHolderBody(): Record<string, unknown> {
  const { accountHolder: _drop, ...rest } = realMoneyPayBody();
  return rest;
}

async function seedOwner(fullName: string, partnerId: string) {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso, fullName,
  });
}

/** OWNER: certified with an approved provider block, on an http rail, live OFAC list. */
async function liveOwner() {
  await seedPartner(db, OWNER, 'Acme');
  await certifyPartnerForTest(db, OWNER, { approvedDisclosure: true });
  await setRailProviderType(db, OWNER, 'http');
  rails.byPartner[OWNER] = HTTP_RAIL;
  primeOfacSource({ checkedAgoMs: H });
  await seedOwner('Alex Sender', OWNER);
}

async function saveBook(partnerId: string, o: { legalName?: string; payoutDestination?: string } = {}) {
  await createRecipientRepo(db).upsertRecipient(
    partnerId,
    SENDER,
    { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: o.payoutDestination ?? ACCOUNT, lastUsedAt: new Date().toISOString() },
    o.legalName === undefined ? {} : { legalName: o.legalName },
  );
}
const bookName = (partnerId: string) => createRecipientRepo(db).getRecipientLegalName(partnerId, SENDER, RP);
const legalOf = async (id: string) => (await store.getTransferDecrypted(id))?.recipientLegalName;

async function legalNameSetRows(id?: string) {
  const r = (await db.execute(
    sql`SELECT partner_id, subject_id, meta FROM audit_events WHERE action = 'transfer.legal_name_set' ORDER BY id`,
  )) as unknown as { rows: Array<{ partner_id: string; subject_id: string; meta: unknown }> };
  return id ? r.rows.filter((x) => x.subject_id === id) : r.rows;
}
async function screenParties(id: string): Promise<string[][]> {
  const r = (await db.execute(
    sql`SELECT meta FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id} ORDER BY id`,
  )) as unknown as { rows: Array<{ meta: { parties: Array<{ role: string }> } }> };
  return r.rows.map((x) => x.meta.parties.map((p) => p.role));
}
async function outboxKinds(): Promise<string[]> {
  const r = (await db.execute(sql`SELECT kind FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ kind: string }> };
  return r.rows.map((x) => x.kind);
}

async function makeDraft(o: Partial<Draft> = {}): Promise<string> {
  return draftStore.createDraft({
    senderPhone: SENDER,
    partnerId: OWNER,
    recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: ACCOUNT },
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    ...o,
  } as Omit<Draft, 'createdAt' | 'channel'> & { partnerId: string });
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  rails.byPartner = {};
  fault.guardMiss = false;
  fault.bookThrows = false;
  fault.railReadFailNext = false;
  otp.verify = vi.fn(async () => okVerify());
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(fakeRedis());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  const keep = (...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreOfacSource(originalList);
});
afterAll(() => {
  // No PII: the typed names and the phones never reach a console line in this file.
  for (const line of consoleLines) {
    for (const p of PII) expect(line).not.toContain(p);
  }
});

describe('pay route, existing transfer, real money: the account-holder rule before the code (C18 step 1)', { retry: 0 }, () => {
  it('no name on file, body WITHOUT accountHolder -> 409 reload_required; the code is not checked', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-old-tab' }));
    const res = await post('ah-old-tab', noHolderBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(otp.verify).not.toHaveBeenCalled();
    expect((await store.getTransfer('ah-old-tab'))?.status).toBe('awaiting_payment');
  });

  it("accountHolder '' -> 400 with the field error; the code is not checked", async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-empty' }));
    const res = await post('ah-empty', realMoneyPayBody({ accountHolder: '' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(ERROR_400);
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['a control character', 'Anita\u0007Legal'],
    ['81 characters', 'A'.repeat(81)],
    ['a non-string value', 42],
  ])('an invalid name (%s) -> 400 on real money, the code is not checked', async (_label, accountHolder) => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-bad' }));
    const res = await post('ah-bad', { ...noHolderBody(), accountHolder });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(ERROR_400);
    expect(otp.verify).not.toHaveBeenCalled();
    expect(await legalOf('ah-bad')).toBeUndefined();
  });

  it.each([
    ['a control character', 'Anita\u0007Legal'],
    ['81 characters', 'A'.repeat(81)],
  ])('an invalid name (%s) -> the same 400 on a non-real-money default transfer (no rail row)', async (_label, accountHolder) => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'ah-bad-default', partnerId: 'default' }));
    const res = await post('ah-bad-default', { otp: '000000', accountHolder });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(ERROR_400);
    expect(otp.verify).not.toHaveBeenCalled();
  });
});

describe('pay route, existing transfer, real money: the typed name (C18 steps 3-6)', { retry: 0 }, () => {
  it('a valid typed name is written before the re-screen (recipient, sender, recipient); the row settles; the empty book row is filled', async () => {
    await liveOwner();
    await saveBook(OWNER);
    await store.saveTransfer(makeTransfer({ id: 'ah-typed' }));
    const res = await post('ah-typed', realMoneyPayBody({ accountHolder: `  ${TYPED} ` }));
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    expect(await legalOf('ah-typed')).toBe(TYPED);
    expect(await legalNameSetRows('ah-typed')).toEqual([
      { partner_id: OWNER, subject_id: 'ah-typed', meta: { source: 'pay_page' } },
    ]);
    // The pay-time screen covers the legal name and the chat name (the screened set equals the row).
    expect(await screenParties('ah-typed')).toEqual([['recipient', 'sender', 'recipient']]);
    const t = await store.getTransfer('ah-typed');
    expect(t?.status).toBe('paid');
    expect(t?.complianceReasons).toEqual([]);
    expect(await outboxKinds()).toContain('settlement.instruct');
    expect(await bookName(OWNER)).toBe(TYPED);
  });

  it('a name already on file: the key may be absent; a typed different name is ignored (no write, no audit, book untouched)', async () => {
    await liveOwner();
    await saveBook(OWNER);
    await store.saveTransfer(makeTransfer({ id: 'ah-onfile-1', recipientLegalName: 'Anita Legal' }));
    expect(await (await post('ah-onfile-1', noHolderBody())).json()).toEqual({ ok: true, status: 'processing' });
    await store.saveTransfer(makeTransfer({ id: 'ah-onfile-2', recipientLegalName: 'Anita Legal' }));
    expect(await (await post('ah-onfile-2', realMoneyPayBody({ accountHolder: TYPED }))).json()).toEqual({ ok: true, status: 'processing' });
    expect(await legalOf('ah-onfile-2')).toBe('Anita Legal');
    expect(await legalNameSetRows()).toEqual([]);
    expect(await bookName(OWNER)).toBeNull();
  });

  it("a typed watchlist name -> 400 \"We can't process this transfer.\", blocked by the re-screen (the write came first)", async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-listed' }));
    const res = await post('ah-listed', realMoneyPayBody({ accountHolder: 'Testa Fixturelli' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "We can't process this transfer." });
    expect((await store.getTransfer('ah-listed'))?.status).toBe('blocked');
    expect(await legalOf('ah-listed')).toBe('Testa Fixturelli');
    expect(await outboxKinds()).not.toContain('settlement.instruct');
  });

  it('the guard misses: one warn with the transfer id only, the payment goes on and is held RECIPIENT_IDENTITY_MISSING', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-guard' }));
    fault.guardMiss = true;
    const before = consoleLines.length;
    expect(await (await post('ah-guard', realMoneyPayBody({ accountHolder: TYPED }))).json()).toEqual({ ok: true, status: 'in_review' });
    const t = await store.getTransfer('ah-guard');
    expect(t?.complianceReasons).toContain(RECIPIENT_IDENTITY_MISSING_REASON);
    expect(await outboxKinds()).not.toContain('settlement.instruct');
    expect(await legalNameSetRows()).toEqual([]);
    const lines = consoleLines.slice(before).filter((l) => l.includes('pay.legal_name_not_written'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ah-guard');
  });

  it('the book fill throws: the response is unchanged (200), one warn with the transfer id', async () => {
    await liveOwner();
    await saveBook(OWNER);
    await store.saveTransfer(makeTransfer({ id: 'ah-bookfail' }));
    fault.bookThrows = true;
    const before = consoleLines.length;
    const res = await post('ah-bookfail', realMoneyPayBody({ accountHolder: TYPED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    const lines = consoleLines.slice(before).filter((l) => l.includes('pay.legal_name_book'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ah-bookfail');
  });

  it('the legal-name write throws -> 503 approval_not_recorded, never charged, still awaiting; no raw error is logged', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-writefail' }));
    await db.execute(sql.raw(`CREATE FUNCTION fail_ah_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ah-trigger-secret %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_ah_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'transfer.legal_name_set') EXECUTE FUNCTION fail_ah_audit()`));
    // freshDb truncates tables but keeps triggers: drop it for the next test.
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_ah_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_ah_audit()'));
    });
    const before = consoleLines.length;
    const res = await post('ah-writefail', realMoneyPayBody({ accountHolder: TYPED }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    const t = await store.getTransfer('ah-writefail');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
    expect(await legalOf('ah-writefail')).toBeUndefined();
    expect(await outboxKinds()).toEqual([]);
    const lines = consoleLines.slice(before);
    expect(lines.filter((l) => l.includes('pay.legal_name_write'))).toHaveLength(1);
    for (const l of lines) {
      expect(l).not.toContain('ah-trigger-secret');
      expect(l).not.toContain('pay.route');
    }
  });

  it('a Partner-API-minted real-money b2c row: no accountHolder key -> pays, no legal_name_set row, settles (exempt)', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-api' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-1', 'ah-api');
    expect(await (await post('ah-api', noHolderBody())).json()).toEqual({ ok: true, status: 'processing' });
    expect(await legalNameSetRows()).toEqual([]);
    const t = await store.getTransfer('ah-api');
    expect(t?.status).toBe('paid');
    expect(t?.complianceReasons).not.toContain(RECIPIENT_IDENTITY_MISSING_REASON);
    expect(await outboxKinds()).toContain('settlement.instruct');
  });
});

describe('pay route, default tenant (not real money): an old tab pays as before (C18, critic M3)', { retry: 0 }, () => {
  it('absent key pays as before and makes NO legal-name read', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'ah-def', partnerId: 'default' }));
    const stop = captureQueries();
    let queries: Array<{ sql: string }> = [];
    try {
      expect(await (await post('ah-def', { otp: '000000' })).json()).toEqual({ ok: true, status: 'paid' });
    } finally {
      queries = stop();
    }
    expect(queries.filter((q) => q.sql.includes('"recipient_legal_name_enc" is null'))).toEqual([]);
    expect(queries.filter((q) => /from "recipients"/i.test(q.sql) && q.sql.includes('legal_name_enc'))).toEqual([]);
    expect(otp.verify).toHaveBeenCalledTimes(1);
  });

  it("'' pays and writes nothing", async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'ah-def-empty', partnerId: 'default' }));
    expect(await (await post('ah-def-empty', { otp: '000000', accountHolder: '' })).json()).toEqual({ ok: true, status: 'paid' });
    expect(await legalOf('ah-def-empty')).toBeUndefined();
    expect(await legalNameSetRows()).toEqual([]);
  });

  it('a valid name is written', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'ah-def-name', partnerId: 'default' }));
    expect(await (await post('ah-def-name', { otp: '000000', accountHolder: TYPED })).json()).toEqual({ ok: true, status: 'paid' });
    expect(await legalOf('ah-def-name')).toBe(TYPED);
    expect(await legalNameSetRows('ah-def-name')).toEqual([
      { partner_id: 'default', subject_id: 'ah-def-name', meta: { source: 'pay_page' } },
    ]);
  });

  it('default tenant whose rail-type read fails: absent key still pays (realMoneyForField false)', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'ah-def-railfail', partnerId: 'default' }));
    fault.railReadFailNext = true;
    expect(await (await post('ah-def-railfail', { otp: '000000' })).json()).toEqual({ ok: true, status: 'paid' });
    expect(fault.railReadFailNext).toBe(false); // the gate context's read was the one that failed
  });
});

describe('pay route, draft branch, real money (C18 draft branch)', { retry: 0 }, () => {
  it('the typed name reaches the mint and the book', async () => {
    await liveOwner();
    await saveBook(OWNER);
    const draftId = await makeDraft();
    const res = await post(draftId, realMoneyPayBody({ accountHolder: TYPED }));
    expect(res.status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe(TYPED);
    expect((await store.getTransfer(created.id))?.status).toBe('paid');
    expect(await bookName(OWNER)).toBe(TYPED);
  });

  it('a draft with its own legal name ignores the typed one (nothing filled in the book)', async () => {
    await liveOwner();
    await saveBook(OWNER);
    const draftId = await makeDraft({ recipientLegalName: 'Draft Legal' });
    expect((await post(draftId, realMoneyPayBody({ accountHolder: TYPED }))).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe('Draft Legal');
    expect(await bookName(OWNER)).toBeNull();
  });

  it('a book name for ANOTHER account: without accountHolder -> 409 reload_required; with one the mint takes the typed name, not the book', async () => {
    await liveOwner();
    await saveBook(OWNER, { legalName: 'Other Book', payoutDestination: OTHER_ACCOUNT });
    const draftId = await makeDraft();
    const refused = await post(draftId, noHolderBody());
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
    expect(await store.listTransfers()).toEqual([]);
    expect((await post(draftId, realMoneyPayBody({ accountHolder: TYPED }))).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe(TYPED);
  });

  it('a book name for the SAME account: no accountHolder key -> pays, the mint carries the book name', async () => {
    await liveOwner();
    await saveBook(OWNER, { legalName: 'Anita Legal' });
    const draftId = await makeDraft();
    expect((await post(draftId, noHolderBody())).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe('Anita Legal');
    expect(await legalNameSetRows()).toEqual([]);
  });

  it('a b2b draft is never asked: the absent key goes through to the code and the finalizer', async () => {
    await liveOwner();
    const draftId = await makeDraft({
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer Co', recipientBusinessName: 'Seller Co',
    });
    const res = await post(draftId, noHolderBody());
    const body = (await res.json()) as { reason?: string; fieldErrors?: Record<string, string> };
    expect(body.reason).not.toBe('reload_required');
    expect(body.fieldErrors?.accountHolder).toBeUndefined();
    expect(otp.verify).toHaveBeenCalledTimes(1);
  });
});
