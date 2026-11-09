/**
 * Program-Fix 14 follow-up: paying an EXISTING transfer (e.g. a scheduled
 * transfer awaiting payment) re-screens both parties before any charge.
 *   match              → blocked (never charged, never instructed), evidence row
 *   possible / no list → flagged → the normal hold (in_review), never instructed
 *   clear              → today's path unchanged (plus one evidence row)
 * A consumer sender with no legal name on file is refused (sender_name_required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import {
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
} from '@/lib/compliance-config';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence, setRailProviderType } from './helpers-sanctions';
import { SENDER_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';

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
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
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
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
// Per-partner rail config the route reads (fix pack 2 T3 tests set an http
// rail here AND in partner_integrations, which live-gate.ts reads).
const rails = vi.hoisted(() => ({ byPartner: {} as Record<string, PartnerIntegrations['payment']> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, payment: rails.byPartner[id] ?? {}, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// The mock list never returns a possible match and never fails to load, so the
// screener is switchable per test: 'real' is the production mock list.
let screenerMode: 'real' | 'possible' | 'unavailable' = 'real';
vi.mock('@/lib/providers/sanctions-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/sanctions-provider')>();
  return {
    ...real,
    getSanctionsScreener: (list: string[]) => {
      if (screenerMode === 'real') return real.getSanctionsScreener(list);
      return {
        listInfo: () => ({ source: 'test-list', version: 't1', hash: 'h' }),
        screen: async () => {
          if (screenerMode === 'unavailable') throw new SanctionsListUnavailableError();
          return { matched: false, possibleMatch: true, matchScore: 0.9, entryId: 'test:1' };
        },
      };
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const SENDER_PHONE = '15551234567';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER_PHONE, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

function post(id: string, body: unknown = { otp: '000000' }) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

async function seedOwner(fullName: string | undefined) {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER_PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
    ...(fullName !== undefined ? { fullName } : {}),
  });
}

async function screenRows(id: string) {
  const r = (await db.execute(
    sql`SELECT actor_type, meta FROM audit_events WHERE action = 'sanctions.screen' AND subject_id = ${id} ORDER BY id`,
  )) as unknown as { rows: Array<{ actor_type: string; meta: { decision: string; parties: Array<{ role: string }> } }> };
  return r.rows;
}

async function outboxKinds() {
  const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; dedupe_key: string }>;
  };
  return r.rows.map((x) => [x.kind, x.dedupe_key]);
}

const originalList = process.env.SANCTIONS_LIST;
beforeEach(async () => {
  screenerMode = 'real';
  rails.byPartner = {};
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
});

describe('pay route — existing transfer is re-screened before payment (Program-Fix 14)', { retry: 0 }, () => {
  it('clear: settles exactly as before, plus one PII-free sanctions.screen evidence row covering both parties', async () => {
    await seedOwner('Alex Sender');
    await store.saveTransfer(makeTransfer({ id: 'rs-clear' }));
    const res = await post('rs-clear');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    const t = await store.getTransfer('rs-clear');
    expect(t?.status).toBe('paid');
    expect(t?.complianceStatus).toBe('cleared');
    expect(t?.complianceReasons).toEqual([]);
    expect(await outboxKinds()).toEqual([
      ['whatsapp.text', 'stage1:rs-clear'],
      ['mock.settle', 'mocksettle:rs-clear'],
    ]);
    const rows = await screenRows('rs-clear');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe('system');
    expect(rows[0].meta.decision).toBe('clear');
    expect(rows[0].meta.parties.map((p) => p.role)).toEqual(['recipient', 'sender']);
    const json = JSON.stringify(rows[0].meta).toLowerCase();
    expect(json).not.toContain('alex');
    expect(json).not.toContain('mom');
  });

  it('a large amount already decided at mint is not re-flagged: a cleared row still settles', async () => {
    await seedOwner('Alex Sender');
    await store.saveTransfer(makeTransfer({ id: 'rs-large', amountUsd: 1500, totalChargeUsd: 1500, amountSource: 1500, totalChargeSource: 1500 }));
    const res = await post('rs-large');
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect((await store.getTransfer('rs-large'))?.complianceReasons).toEqual([]);
  });

  it('sender on the watchlist: blocked, never charged, never instructed, evidence recorded', async () => {
    await seedOwner('John Doe');
    await store.saveTransfer(makeTransfer({ id: 'rs-sender' }));
    const res = await post('rs-sender');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "We can't process this transfer." });
    const t = await store.getTransfer('rs-sender');
    expect(t?.status).toBe('blocked');
    expect(t?.complianceStatus).toBe('blocked');
    expect(t?.complianceReasons).toContain(SENDER_WATCHLIST_REASON);
    expect(t?.fundingRef ?? null).toBeNull();
    expect(await outboxKinds()).toEqual([]);
    const rows = await screenRows('rs-sender');
    expect(rows.map((r) => r.meta.decision)).toEqual(['match']);
    expect(JSON.stringify(rows[0].meta).toLowerCase()).not.toContain('john');
  });

  it('recipient legal name on the watchlist (decrypted read): blocked', async () => {
    await seedOwner('Alex Sender');
    await store.saveTransfer(makeTransfer({ id: 'rs-recip', recipientName: 'Mom', recipientLegalName: 'Jane Roe' }));
    const res = await post('rs-recip');
    expect(res.status).toBe(400);
    const t = await store.getTransfer('rs-recip');
    expect(t?.status).toBe('blocked');
    expect(t?.complianceReasons).toContain(RECIPIENT_WATCHLIST_REASON);
    expect(await outboxKinds()).toEqual([]);
  });

  it('a hit blocks before any payout write: submitted bank details are not stored', async () => {
    await seedOwner('John Doe');
    await store.saveTransfer(makeTransfer({ id: 'rs-nobank', payoutDestination: '' }));
    const res = await post('rs-nobank', {
      otp: '000000', country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' },
    });
    expect(res.status).toBe(400);
    const t = await store.getTransferDecrypted('rs-nobank');
    expect(t?.status).toBe('blocked');
    expect(t?.payoutDestination).toBe('');
  });

  it('a charged row that hits keeps awaiting_payment (the funding-resume sweep raises its alert) but is blocked for compliance', async () => {
    await seedOwner('John Doe');
    await store.saveTransfer(makeTransfer({ id: 'rs-charged' }));
    await createTransferRepo(db).setFundingRef('rs-charged', 'fund-test-1');
    const res = await post('rs-charged');
    expect(res.status).toBe(400);
    const t = await store.getTransfer('rs-charged');
    expect(t?.complianceStatus).toBe('blocked');
    expect(t?.status).toBe('awaiting_payment');
    expect(await outboxKinds()).toEqual([]);
  });

  it('possible match: flagged and held (in_review), never instructed', async () => {
    await seedOwner('Alex Sender');
    screenerMode = 'possible';
    await store.saveTransfer(makeTransfer({ id: 'rs-possible' }));
    const res = await post('rs-possible');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'in_review' });
    const t = await store.getTransfer('rs-possible');
    expect(t?.status).toBe('in_review');
    expect(t?.complianceStatus).toBe('flagged');
    expect(t?.complianceReasons).toEqual([POSSIBLE_MATCH_REASON]);
    expect(await outboxKinds()).toEqual([['whatsapp.text', 'stage1:rs-possible']]);
    expect((await screenRows('rs-possible')).map((r) => r.meta.decision)).toEqual(['possible_match']);
  });

  it('screening list unavailable: fails closed to the hold', async () => {
    await seedOwner('Alex Sender');
    screenerMode = 'unavailable';
    await store.saveTransfer(makeTransfer({ id: 'rs-nolist' }));
    const res = await post('rs-nolist');
    expect(await res.json()).toEqual({ ok: true, status: 'in_review' });
    const t = await store.getTransfer('rs-nolist');
    expect(t?.complianceStatus).toBe('flagged');
    expect(t?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(await outboxKinds()).toEqual([['whatsapp.text', 'stage1:rs-nolist']]);
  });

  it('an already-flagged row keeps its reasons and adds the screening reason once', async () => {
    await seedOwner('Alex Sender');
    screenerMode = 'possible';
    await store.saveTransfer(makeTransfer({
      id: 'rs-flagged', payoutDestination: '', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'],
    }));
    // No destination: the POST refuses with 400 after the re-screen (row stays awaiting).
    expect((await post('rs-flagged')).status).toBe(400);
    expect((await post('rs-flagged')).status).toBe(400);
    const t = await store.getTransfer('rs-flagged');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.complianceReasons).toEqual(['Large transfer amount.', POSSIBLE_MATCH_REASON]);
  });

  it('no legal name on file: 400 sender_name_required, nothing screened or written', async () => {
    await seedOwner(undefined);
    await store.saveTransfer(makeTransfer({ id: 'rs-noname' }));
    const res = await post('rs-noname');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'sender_name_required' });
    const t = await store.getTransfer('rs-noname');
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.complianceStatus).toBe('cleared');
    expect(await screenRows('rs-noname')).toEqual([]);
    expect(await outboxKinds()).toEqual([]);
  });
});

// Fix pack 2 T3 (R02): the pay-time re-screen of a transfer whose RAIL partner
// (routed, else owner) settles on http is a real-money screen: it clears only
// on a LIVE list and must cover every name screened before.
describe('pay route — real-money re-screen needs a live list (fix pack 2 T3)', { retry: 0 }, () => {
  const HTTP_RAIL: PartnerIntegrations['payment'] = {
    providerType: 'http',
    credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' },
  };
  const H = 3_600_000;
  async function httpRail(partnerId: string) {
    if (partnerId !== 'default') {
      await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
        VALUES (${partnerId}, ${partnerId}, 'active', '["US"]'::jsonb, 'ours') ON CONFLICT (id) DO NOTHING`);
    }
    await setRailProviderType(db, partnerId, 'http');
    rails.byPartner[partnerId] = HTTP_RAIL;
  }
  const kinds = async () => (await outboxKinds()).map(([k]) => k);

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOfacSource(originalList);
  });

  it('http rail on the mock list (never live) → in_review LIST_UNAVAILABLE, not instructed', async () => {
    await seedOwner('Alex Sender');
    await httpRail('default');
    await store.saveTransfer(makeTransfer({ id: 'lv-mock' }));
    expect(await (await post('lv-mock')).json()).toEqual({ ok: true, status: 'in_review' });
    const t = await store.getTransfer('lv-mock');
    expect(t?.complianceStatus).toBe('flagged');
    expect(t?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(await kinds()).not.toContain('settlement.instruct');
  });

  it('http rail, OFAC list checked 35 h ago (live) → paid and instructed', async () => {
    await seedOwner('Alex Sender');
    await httpRail('default');
    primeOfacSource({ checkedAgoMs: 35 * H });
    await store.saveTransfer(makeTransfer({ id: 'lv-35' }));
    // A webhook-driven rail answers 'processing'; the ledger row is paid.
    expect(await (await post('lv-35')).json()).toEqual({ ok: true, status: 'processing' });
    expect((await store.getTransfer('lv-35'))?.status).toBe('paid');
    expect(await kinds()).toContain('settlement.instruct');
  });

  it('http rail, OFAC list checked 37 h ago (stale) → in_review LIST_UNAVAILABLE', async () => {
    await seedOwner('Alex Sender');
    await httpRail('default');
    primeOfacSource({ checkedAgoMs: 37 * H });
    await store.saveTransfer(makeTransfer({ id: 'lv-37' }));
    expect(await (await post('lv-37')).json()).toEqual({ ok: true, status: 'in_review' });
    expect((await store.getTransfer('lv-37'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(await kinds()).not.toContain('settlement.instruct');
  });

  it('a default-tenant transfer ROUTED to an http partner, stale list → in_review (the rail partner decides)', async () => {
    await seedOwner('Alex Sender');
    await httpRail('railp');
    primeOfacSource({ checkedAgoMs: 37 * H });
    await store.saveTransfer(makeTransfer({ id: 'lv-routed', settlementPartnerId: 'railp' }));
    expect(await (await post('lv-routed')).json()).toEqual({ ok: true, status: 'in_review' });
    expect((await store.getTransfer('lv-routed'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
  });

  it('the sender legal name changed since the mint → in_review SENDER_IDENTITY_MISSING (the old name is uncovered)', async () => {
    await seedOwner('Alex Sender');
    await httpRail('default');
    primeOfacSource({ checkedAgoMs: H });
    await store.saveTransfer(makeTransfer({ id: 'lv-renamed' }));
    await seedLiveEvidence(db, { id: 'lv-renamed', partnerId: 'default', recipientName: 'Mom', senderName: 'Alexandra Previous' });
    expect(await (await post('lv-renamed')).json()).toEqual({ ok: true, status: 'in_review' });
    const t = await store.getTransfer('lv-renamed');
    expect(t?.complianceStatus).toBe('flagged');
    expect(t?.complianceReasons).toEqual([SENDER_IDENTITY_MISSING_REASON]);
    expect(await kinds()).not.toContain('settlement.instruct');
  });

  it('pay-time block writes notices', async () => {
    // Fix pack 2 T5 (R04): the routed rail partner is emailed; the default owner is not.
    await seedOwner('Alex Sender');
    await httpRail('railp');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ alertEmail: 'ops@railp.example' })}::jsonb WHERE id = 'railp'`);
    primeOfacSource({ checkedAgoMs: H });
    await store.saveTransfer(makeTransfer({ id: 'lv-block', settlementPartnerId: 'railp', recipientLegalName: 'Testa Fixturelli' }));
    expect((await post('lv-block')).status).toBe(400);
    expect((await store.getTransfer('lv-block'))?.status).toBe('blocked');
    expect(await outboxKinds()).toEqual([
      ['ops.alert', 'sanctionsblock:lv-block'],
      ['email.send', 'sanctionsblockmail:lv-block:railp'],
    ]);
    const r = (await db.execute(sql`SELECT partner_id, meta FROM audit_events WHERE action = 'sanctions.block' AND subject_id = 'lv-block'`)) as unknown as {
      rows: Array<{ partner_id: string; meta: Record<string, unknown> }>;
    };
    expect(r.rows).toMatchObject([{ partner_id: 'default', meta: { stage: 'pay', environment: 'live', realMoney: true, quiet: false } }]);
  });

  it('demo name on simulator -> audit only', async () => {
    await seedOwner('Alex Sender');
    await setRailProviderType(db, 'default', 'simulator');
    await store.saveTransfer(makeTransfer({ id: 'lv-demo', recipientLegalName: 'John Doe' }));
    expect((await post('lv-demo')).status).toBe(400);
    expect((await store.getTransfer('lv-demo'))?.status).toBe('blocked');
    expect(await outboxKinds()).toEqual([]);
    const r = (await db.execute(sql`SELECT meta FROM audit_events WHERE action = 'sanctions.block' AND subject_id = 'lv-demo'`)) as unknown as {
      rows: Array<{ meta: Record<string, unknown> }>;
    };
    expect(r.rows.map((x) => x.meta)).toMatchObject([{ stage: 'pay', quiet: true, realMoney: false }]);
  });

  it('a mock rail with a stale list → paid (demo unchanged)', async () => {
    await seedOwner('Alex Sender');
    await setRailProviderType(db, 'default', 'mock');
    primeOfacSource({ checkedAgoMs: 37 * H });
    await store.saveTransfer(makeTransfer({ id: 'lv-mockrail' }));
    expect(await (await post('lv-mockrail')).json()).toEqual({ ok: true, status: 'paid' });
  });

  it('a sandbox transfer is never paid on the hosted page (unchanged): 404, nothing screened or written', async () => {
    await seedOwner('Alex Sender');
    await httpRail('default');
    await store.saveTransfer(makeTransfer({ id: 'lv-sandbox', environment: 'test' }));
    const res = await post('lv-sandbox');
    expect(res.status).toBe(404);
    expect((await store.getTransfer('lv-sandbox'))?.status).toBe('awaiting_payment');
    expect(await screenRows('lv-sandbox')).toEqual([]);
    expect(await kinds()).toEqual([]);
  });
});
