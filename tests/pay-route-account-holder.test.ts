/**
 * Fix pack 4 T15 (C18, C17, R03): the pay route captures the recipient's
 * account-holder name BEFORE the pay-time re-screen.
 *   - real money, no name on file: the key is required (absent -> 409 reload,
 *     '' or invalid -> 400), answered before the code is checked;
 *   - a typed valid name is written fill-only with its transfer.legal_name_set
 *     row in ONE transaction, then the re-screen covers it (chat + legal);
 *   - without new bank details a name already on file is never replaced; exempt
 *     rows are never asked;
 *   - review R1-P2 D1: a name posted next to new bank details is the name for
 *     that account (it replaces the row's or the draft's name; on real money it
 *     is required); new details with no name drop the old account's name;
 *   - after a 2xx the saved recipient's EMPTY book entry is filled, only while
 *     it holds the account paid (review R1-P2 D2/E1/F1);
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
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { defaultProvider, encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
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
// Review R1-P1 A2: nameThrows makes the guarded legal-name write itself throw.
// Review R3-X1 N1: rescreenThrows makes the pay-time re-screen's evidence read fail (an infra
// error); bindIntentAfterRescreen binds a funding intent to that row right after the re-screen,
// so the payout guard misses between the route's read and its write.
const fault = vi.hoisted(() => ({
  guardMiss: false, bookThrows: false, railReadFailNext: false, nameThrows: false,
  rescreenThrows: false, bindIntentAfterRescreen: null as string | null,
}));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const repo = real.createTransferRepo(...a);
      if (fault.nameThrows) {
        const boom = async (): Promise<never> => { throw new TypeError('name-write-secret'); };
        return { ...repo, setRecipientLegalNameIfEditable: boom, lockEditablePayout: boom, setPayoutIfEditable: boom };
      }
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
// Review R1-P2 D1: the names the pay-time re-screen was given (the screening input seam).
const screened = vi.hoisted(() => ({ recipientNames: [] as string[] }));
vi.mock('@/lib/pay-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-rescreen')>();
  return {
    ...real,
    rescreenBeforePay: async (...a: Parameters<typeof real.rescreenBeforePay>) => {
      screened.recipientNames.push(a[2].recipientName);
      if (fault.rescreenThrows) throw Object.assign(new Error('evidence read failed'), { code: 'ECONNRESET' });
      const out = await real.rescreenBeforePay(...a);
      if (fault.bindIntentAfterRescreen) {
        const { createTransferRepo } = await import('@/db/repos/transfer-repo');
        await createTransferRepo(db).bindFundingIntent(fault.bindIntentAfterRescreen, OWNER, 'stripe', 'pi_race');
      }
      return out;
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
const PII = ['Alice A', 'Ravi K', 'Bob B', 'Typed Holder', 'Anita Legal', 'Testa Fixturelli', 'Draft Legal', 'Other Book', 'Old Holder', 'New Holder', SENDER, RP];

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
  fault.nameThrows = false;
  fault.rescreenThrows = false;
  fault.bindIntentAfterRescreen = null;
  screened.recipientNames = [];
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
    // Review R1-P1 A2: the one deduped payevidence ops alert, nothing else.
    expect(await outboxKinds()).toEqual(['ops.alert']);
    const lines = consoleLines.slice(before);
    expect(lines.filter((l) => l.includes('pay.legal_name_write'))).toHaveLength(1);
    for (const l of lines) {
      expect(l).not.toContain('ah-trigger-secret');
      expect(l).not.toContain('pay.route');
    }
  });

  it('the repo write throws (review R1-P1 A2) -> 503 approval_not_recorded and ONE payevidence ops alert; the error name only is logged', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'ah-namethrow' }));
    fault.nameThrows = true;
    const before = consoleLines.length;
    const res = await post('ah-namethrow', realMoneyPayBody({ accountHolder: TYPED }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(otp.verify).toHaveBeenCalledOnce(); // the code was spent: the alert makes the fault visible
    const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ kind: string; dedupe_key: string | null }>;
    };
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('ops.alert');
    expect(r.rows[0].dedupe_key).toBe(`payevidence:${new Date().toISOString().slice(0, 13)}`);
    const t = await store.getTransfer('ah-namethrow');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
    const lines = consoleLines.slice(before);
    expect(lines.filter((l) => l.includes('pay.legal_name_write'))).toHaveLength(1);
    for (const l of lines) expect(l).not.toContain('name-write-secret');
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

// Review R1-P2: the account-holder name is bound to the account it was typed for.
// The composed IN destination is '<IFSC> <account>' (SAME_DEST, NEW_DEST); the repo's
// last 4 are the last 4 DIGITS, so ACCOUNT ('...|HDFC0001234', '1234'), SAME_DEST ('9012')
// and NEW_DEST ('7777') are three accounts.
const SAME_FIELDS = { country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } };
const NEW_FIELDS = { country: 'IN', fields: { accountNumber: '555566667777', ifsc: 'SBIN0005678' } };
const NEW_DEST = 'SBIN0005678 555566667777';
const SAME_DEST = 'HDFC0001234 123456789012';
const bookNameFor = (partnerId: string, payoutDestination: string) =>
  createRecipientRepo(db).getRecipientLegalName(partnerId, SENDER, RP, { payoutMethod: 'bank', payoutDestination });

describe('review R1-P2 D2/E1/F1: the book fill names the account that was PAID', { retry: 0 }, () => {
  it('edit path: the book holds account A, the transfer is paid to account B with a typed name -> 200, the book name for A stays empty', async () => {
    await liveOwner();
    await saveBook(OWNER);
    await store.saveTransfer(makeTransfer({ id: 'bf-edit' }));
    const res = await post('bf-edit', { ...realMoneyPayBody({ accountHolder: TYPED }), ...NEW_FIELDS });
    expect(res.status).toBe(200);
    expect(await legalOf('bf-edit')).toBe(TYPED);
    expect((await store.getTransferDecrypted('bf-edit'))?.payoutDestination).toBe(NEW_DEST);
    expect(await bookName(OWNER)).toBeNull();
    expect(await bookNameFor(OWNER, ACCOUNT)).toBeNull();
  });

  it('stored path: the book moved to another account after the mint -> 200, the book name stays empty', async () => {
    await liveOwner();
    await saveBook(OWNER);
    await store.saveTransfer(makeTransfer({ id: 'bf-stored' }));
    await saveBook(OWNER, { payoutDestination: NEW_DEST }); // a portal edit after the mint
    const res = await post('bf-stored', realMoneyPayBody({ accountHolder: TYPED }));
    expect(res.status).toBe(200);
    expect(await legalOf('bf-stored')).toBe(TYPED);
    expect(await bookName(OWNER)).toBeNull();
  });

  it('happy path, edit to the SAME account the book holds (a first collection): the book is filled', async () => {
    await liveOwner();
    await saveBook(OWNER, { payoutDestination: SAME_DEST });
    await store.saveTransfer(makeTransfer({ id: 'bf-same', payoutDestination: '' }));
    const res = await post('bf-same', { ...realMoneyPayBody({ accountHolder: TYPED }), ...SAME_FIELDS });
    expect(res.status).toBe(200);
    expect(await bookNameFor(OWNER, SAME_DEST)).toBe(TYPED);
  });

  it('draft path: the mint moves the book to the paid account, which is filled', async () => {
    await liveOwner();
    await saveBook(OWNER);
    const draftId = await makeDraft();
    expect((await post(draftId, { ...realMoneyPayBody({ accountHolder: TYPED }), ...NEW_FIELDS })).status).toBe(200);
    expect(await bookNameFor(OWNER, NEW_DEST)).toBe(TYPED);
  });
});

describe('review R1-P2 D1: new bank details on the pay page carry their own account-holder name', { retry: 0 }, () => {
  it('(a) real money: the typed name for the new account REPLACES the old one, is screened, one audit row replaced:true', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'd1-a', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-a', { ...realMoneyPayBody({ accountHolder: 'New Holder' }), ...NEW_FIELDS });
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    expect(await legalOf('d1-a')).toBe('New Holder');
    expect(screened.recipientNames).toEqual(['New Holder']);
    expect(await legalNameSetRows('d1-a')).toEqual([
      { partner_id: OWNER, subject_id: 'd1-a', meta: { source: 'pay_page', replaced: true } },
    ]);
    expect((await store.getTransfer('d1-a'))?.status).toBe('paid');
  });

  it('(b) real money: bank fields and NO accountHolder key -> 409 reload_required, nothing written, the code not checked', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'd1-b', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-b', { ...noHolderBody(), ...NEW_FIELDS });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(otp.verify).not.toHaveBeenCalled();
    const t = await store.getTransferDecrypted('d1-b');
    expect(t?.recipientLegalName).toBe('Old Holder');
    expect(t?.payoutDestination).toBe(ACCOUNT);
    expect(await legalNameSetRows()).toEqual([]);
  });

  it('(b2) real money: bank fields and an invalid name -> the account-holder 400', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'd1-b2', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-b2', { ...realMoneyPayBody({ accountHolder: '' }), ...NEW_FIELDS });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(ERROR_400);
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('(c) real money: a watchlist name typed for the new account is blocked; the old clean name does not shield it', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'd1-c', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-c', { ...realMoneyPayBody({ accountHolder: 'Testa Fixturelli' }), ...NEW_FIELDS });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "We can't process this transfer." });
    expect((await store.getTransfer('d1-c'))?.status).toBe('blocked');
    expect(await outboxKinds()).not.toContain('settlement.instruct');
  });

  it('(d) demo owner: bank fields for another account and no name -> 2xx and the old name is cleared with the payout', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'd1-d', partnerId: 'default', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-d', { otp: '000000', ...NEW_FIELDS });
    expect(res.status).toBe(200);
    const t = await store.getTransferDecrypted('d1-d');
    expect(t?.payoutDestination).toBe(NEW_DEST);
    expect(t?.recipientLegalName).toBeUndefined();
    // The re-screen screened what the row will hold (the chat name), not the old holder.
    expect(screened.recipientNames).toEqual(['Mom']);
  });

  it('(e) demo owner, first collection (empty stored destination): bank fields and no name keep the name', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'd1-e', partnerId: 'default', payoutDestination: '', recipientLegalName: 'Old Holder' }));
    const res = await post('d1-e', { otp: '000000', ...NEW_FIELDS });
    expect(res.status).toBe(200);
    expect(await legalOf('d1-e')).toBe('Old Holder');
    expect(screened.recipientNames).toEqual(['Old Holder']);
  });

  it('(f) draft with its own name and a stored account: new bank fields plus a typed name -> the mint carries (and screened) the typed name', async () => {
    await liveOwner();
    const draftId = await makeDraft({ recipientLegalName: 'Draft Legal' });
    expect((await post(draftId, { ...realMoneyPayBody({ accountHolder: TYPED }), ...NEW_FIELDS })).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe(TYPED);
    // Screened at the mint: a watchlist name typed the same way is blocked.
    const listed = await makeDraft({ recipientLegalName: 'Draft Legal' });
    const res = await post(listed, { ...realMoneyPayBody({ accountHolder: 'Testa Fixturelli' }), ...NEW_FIELDS });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "We can't process this transfer." });
  });

  it('(f2) real money draft with its own name: new bank fields and no accountHolder key -> 409 reload_required', async () => {
    await liveOwner();
    const draftId = await makeDraft({ recipientLegalName: 'Draft Legal' });
    const res = await post(draftId, { ...noHolderBody(), ...NEW_FIELDS });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(await store.listTransfers()).toEqual([]);
  });

  it('(f3) demo draft with its own name and a stored account: new bank fields, no name -> the draft name is not minted', async () => {
    await seedOwner('Alex Sender', 'default');
    const draftId = await makeDraft({ partnerId: 'default', recipientLegalName: 'Draft Legal' });
    expect((await post(draftId, { otp: '000000', ...NEW_FIELDS })).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBeUndefined();
  });

  it('(f4) demo draft with its own name and NO stored account (first collection): bank fields, no name -> the draft name is minted', async () => {
    await seedOwner('Alex Sender', 'default');
    const draftId = await makeDraft({
      partnerId: 'default',
      recipientLegalName: 'Draft Legal',
      recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: '' },
    });
    expect((await post(draftId, { otp: '000000', ...NEW_FIELDS })).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe('Draft Legal');
  });

  it('(h) a Partner-API-minted row with bank fields: never asked (no 409 reload), the payout edit is refused as today', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'd1-h', recipientLegalName: 'Old Holder' }));
    await createIdempotencyRepo(db).claim(OWNER, 'order-h', 'd1-h');
    const res = await post('d1-h', { ...noHolderBody(), ...NEW_FIELDS });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('payout_locked');
    expect(await legalOf('d1-h')).toBe('Old Holder');
    expect(await legalNameSetRows()).toEqual([]);
  });
});

async function payoutEditRows(id: string) {
  const r = (await db.execute(
    sql`SELECT meta FROM audit_events WHERE action = 'transfer.payout_edit' AND subject_id = ${id} ORDER BY id`,
  )) as unknown as { rows: Array<{ meta: unknown }> };
  return r.rows.map((x) => x.meta);
}

// Review R3-X1 N1 (decision D3): with posted bank details, the typed name and the account it
// was typed for are ONE guarded write, after the re-screen. A request that stops before that
// write leaves the old account with its old name.
describe('review R3-X1 N1: the account-holder name and its account are one write, after the re-screen', { retry: 0 }, () => {
  it('(a) the re-screen evidence read fails -> 503; the row keeps account A and "Alice A"; no legal_name_set row', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-a', recipientLegalName: 'Alice A' }));
    fault.rescreenThrows = true;
    const res = await post('n1-a', { ...realMoneyPayBody({ accountHolder: 'Bob B' }), ...NEW_FIELDS });
    expect(res.status).toBe(503);
    const t = await store.getTransferDecrypted('n1-a');
    expect(t?.payoutDestination).toBe(ACCOUNT);
    expect(t?.recipientLegalName).toBe('Alice A');
    expect(await legalNameSetRows()).toEqual([]);
    expect(await payoutEditRows('n1-a')).toEqual([]);
  });

  it('(b) the payout guard misses after the read (an intent bound meanwhile) -> 409 payout_locked; A and "Alice A" kept, nothing written', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-b', recipientLegalName: 'Alice A' }));
    fault.bindIntentAfterRescreen = 'n1-b';
    const res = await post('n1-b', { ...realMoneyPayBody({ accountHolder: 'Bob B' }), ...NEW_FIELDS });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('payout_locked');
    const t = await store.getTransferDecrypted('n1-b');
    expect(t?.payoutDestination).toBe(ACCOUNT);
    expect(t?.recipientLegalName).toBe('Alice A');
    expect(await legalNameSetRows()).toEqual([]);
    expect(await payoutEditRows('n1-b')).toEqual([]);
  });

  it('(c) happy path: account B, "Bob B" and both audit rows; the re-screen screened "Bob B"; settles', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-c', recipientLegalName: 'Alice A' }));
    const res = await post('n1-c', { ...realMoneyPayBody({ accountHolder: 'Bob B' }), ...NEW_FIELDS });
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    const t = await store.getTransferDecrypted('n1-c');
    expect(t?.payoutDestination).toBe(NEW_DEST);
    expect(t?.recipientLegalName).toBe('Bob B');
    expect(screened.recipientNames).toEqual(['Bob B']);
    expect(await legalNameSetRows('n1-c')).toEqual([
      { partner_id: OWNER, subject_id: 'n1-c', meta: { source: 'pay_page', replaced: true } },
    ]);
    expect(await payoutEditRows('n1-c')).toEqual([{ last4: '7777' }]);
    expect(t?.status).toBe('paid');
    expect(t?.complianceReasons).not.toContain(RECIPIENT_IDENTITY_MISSING_REASON);
  });

  it('(c2) first collection with a typed name and no name before: meta has no replaced flag', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-c2', payoutDestination: '' }));
    const res = await post('n1-c2', { ...realMoneyPayBody({ accountHolder: 'Bob B' }), ...NEW_FIELDS });
    expect(await res.json()).toEqual({ ok: true, status: 'processing' });
    expect(await legalOf('n1-c2')).toBe('Bob B');
    expect(await legalNameSetRows('n1-c2')).toEqual([{ partner_id: OWNER, subject_id: 'n1-c2', meta: { source: 'pay_page' } }]);
  });

  it('(e) a watchlist name typed for account B is blocked; nothing is written: A and "Alice A" kept', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-e', recipientLegalName: 'Alice A' }));
    const res = await post('n1-e', { ...realMoneyPayBody({ accountHolder: 'Testa Fixturelli' }), ...NEW_FIELDS });
    expect(res.status).toBe(400);
    expect(screened.recipientNames).toEqual(['Testa Fixturelli']);
    const t = await store.getTransferDecrypted('n1-e');
    expect(t?.status).toBe('blocked');
    expect(t?.payoutDestination).toBe(ACCOUNT);
    expect(t?.recipientLegalName).toBe('Alice A');
    expect(await legalNameSetRows()).toEqual([]);
  });

  it('(f) the combined write throws -> 503 approval_not_recorded and one payevidence alert; nothing written; the error name only', async () => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'n1-f', recipientLegalName: 'Alice A' }));
    fault.nameThrows = true;
    const before = consoleLines.length;
    const res = await post('n1-f', { ...realMoneyPayBody({ accountHolder: 'Bob B' }), ...NEW_FIELDS });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(await outboxKinds()).toEqual(['ops.alert']);
    const t = await store.getTransferDecrypted('n1-f');
    expect(t?.payoutDestination).toBe(ACCOUNT);
    expect(t?.recipientLegalName).toBe('Alice A');
    const lines = consoleLines.slice(before);
    expect(lines.filter((l) => l.includes('pay.legal_name_write'))).toHaveLength(1);
    for (const l of lines) expect(l).not.toContain('name-write-secret');
  });
});

// Review R3-X1 M1 (= Q1, R3): a funded awaiting row never hears "nothing was charged" from a
// failed account-holder write, on either arm (fill-only, or with the bank details).
describe('review R3-X1 M1: the account-holder write 503 carries the funded flag', { retry: 0 }, () => {
  it.each([
    ['the fill-only write (no bank details)', {}],
    ['the combined write (with bank details)', NEW_FIELDS],
  ])('%s throws on a funded row -> 503 approval_not_recorded, funded: true, no "charged"', async (_label, extra) => {
    await liveOwner();
    await store.saveTransfer(makeTransfer({ id: 'm1-funded' }));
    expect(await createTransferRepo(db).bindFundingIntent('m1-funded', OWNER, 'stripe', 'pi_m1')).toBeTruthy();
    fault.nameThrows = true;
    const res = await post('m1-funded', { ...realMoneyPayBody({ accountHolder: TYPED }), ...extra });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'approval_not_recorded', funded: true });
    expect(body.error).not.toMatch(/nothing was charged/i);
    expect(body.error).not.toMatch(/charged/i);
  });
});

// Review R3-X1 N2: a MASKED stored destination is not an account (the page shows a first
// collection), so new bank details with no name keep the row's or the draft's own name.
describe('review R3-X1 N2: a masked stored destination is not an account being replaced', { retry: 0 }, () => {
  it('pay route: a demo transfer storing "****1234" with a legal name; bank details, no accountHolder -> the name is kept', async () => {
    await seedOwner('Alex Sender', 'default');
    await store.saveTransfer(makeTransfer({ id: 'n2-t', partnerId: 'default', recipientLegalName: 'Old Holder' }));
    await db.execute(sql`UPDATE transfers SET payout_destination_enc = ${encryptField('****1234', defaultProvider(), ctx.transfer('n2-t', 'payout_destination_enc'))} WHERE id = 'n2-t'`);
    expect((await store.getTransferDecrypted('n2-t'))?.payoutDestination).toBe('****1234');
    const res = await post('n2-t', { otp: '000000', ...NEW_FIELDS });
    expect(res.status).toBe(200);
    const t = await store.getTransferDecrypted('n2-t');
    expect(t?.payoutDestination).toBe(NEW_DEST);
    expect(t?.recipientLegalName).toBe('Old Holder');
    expect(screened.recipientNames).toEqual(['Old Holder']);
  });

  it('pay-finalize: a demo draft with "Ravi K" and a masked destination; bank details, no typed name -> the minted row keeps "Ravi K"', async () => {
    await seedOwner('Alex Sender', 'default');
    const draftId = await makeDraft({
      partnerId: 'default',
      recipientLegalName: 'Ravi K',
      recipient: { name: 'Mom', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: '****1234' },
    });
    expect((await post(draftId, { otp: '000000', ...NEW_FIELDS })).status).toBe(200);
    const [created] = await store.listTransfers();
    expect(await legalOf(created.id)).toBe('Ravi K');
  });
});
