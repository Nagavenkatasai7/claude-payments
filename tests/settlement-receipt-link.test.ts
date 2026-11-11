import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { beginHold, beginSettlement, receiptUrlFor } from '@/lib/settlement';
import { payUrlFor } from '@/lib/pay-url';
import { receiptLine } from '@/lib/hold-replies';
import { newTransferId } from '@/lib/id';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedOriginatorForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';

// Pack 6 (P10, T9): the stage-1 WhatsApp message (paid or held) carries ONE
// extra line, `Receipt: <the /pay/<id> link>`, for 22-character ids that are
// not payment-link transfers. Eligibility is read on the ROOT handle BEFORE the
// paid-flip transaction; an error there means "no link", never a failed settle.

const probe = vi.hoisted(() => ({
  linkThrows: false,
  order: [] as string[],
  root: null as unknown,
  linkOnRoot: [] as boolean[],
}));

vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (dbx: Parameters<typeof real.createTransferRepo>[0]) => {
      const r = real.createTransferRepo(dbx);
      return {
        ...r,
        isPaymentLinkTransfer: async (id: string) => {
          probe.order.push('isPaymentLinkTransfer');
          probe.linkOnRoot.push(dbx === probe.root);
          if (probe.linkThrows) throw new RangeError('ledger down');
          return r.isPaymentLinkTransfer(id);
        },
      };
    },
  };
});

const logs = vi.hoisted(() => ({ calls: [] as Array<{ level: string; scope: string; message: unknown; fields: unknown }> }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (scope: string, message: unknown, fields?: Record<string, unknown>) => {
      logs.calls.push({ level: 'warn', scope, message, fields });
    },
    logError: (scope: string, message: unknown, fields?: Record<string, unknown>) => {
      logs.calls.push({ level: 'error', scope, message, fields });
    },
  };
});

const PHONE = '15551230000';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: newTransferId(), phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
    webhookSecret: 'w',
  },
  whatsapp: {},
};
const MOCK: PartnerIntegrations = { kyc: {}, payment: {}, whatsapp: {} };

let db: Db;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await seedOriginatorForTest(db, 'acme', PHONE, { address: true, dob: true });
  probe.linkThrows = false;
  probe.order = [];
  probe.root = db;
  probe.linkOnRoot = [];
  logs.calls = [];
});

async function stage1Payload(id: string): Promise<Record<string, unknown>> {
  const r = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = ${'stage1:' + id}`);
  return (r as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
}

async function outboxKinds(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
}

async function markPaymentLink(t: Transfer): Promise<void> {
  await db.execute(sql`INSERT INTO idempotency_keys (partner_id, key, transfer_id) VALUES (${t.partnerId}, ${'paylink:lnk_' + t.id}, ${t.id})`);
}

describe('receiptUrlFor (pack 6 P10)', () => {
  it('a 22-char id that is not a payment-link transfer -> payUrlFor(id)', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    expect(await receiptUrlFor(db, t)).toBe(payUrlFor(t.id));
    expect(logs.calls).toEqual([]);
  });

  it('a legacy 8-char id -> null and NO query', async () => {
    const t = fixture({ id: 'pay12345' });
    await store.saveTransfer(t);
    const stop = captureQueries();
    const url = await receiptUrlFor(db, t);
    const qs = stop();
    expect(url).toBeNull();
    expect(qs).toEqual([]);
    expect(probe.order).toEqual([]);
  });

  it('a payment-link transfer -> null', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    await markPaymentLink(t);
    expect(await receiptUrlFor(db, t)).toBeNull();
    expect(logs.calls).toEqual([]);
  });

  it('isPaymentLinkTransfer throws -> null; one logWarn by error name and transferId, nothing else logged', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    probe.linkThrows = true;
    expect(await receiptUrlFor(db, t)).toBeNull();
    expect(logs.calls).toEqual([{ level: 'warn', scope: 'settle.receipt-link', message: 'RangeError', fields: { transferId: t.id } }]);
    expect(JSON.stringify(logs.calls)).not.toContain(PHONE);
  });

  it('a Partner-API-minted 22-char row gets the link', async () => {
    const t = fixture();
    await store.saveTransfer(t);
    await db.execute(sql`INSERT INTO idempotency_keys (partner_id, key, transfer_id) VALUES ('acme', 'client-key-1', ${t.id})`);
    expect(await createRepoIsPartnerApiMinted(t.id)).toBe(true);
    expect(await receiptUrlFor(db, t)).toBe(payUrlFor(t.id));
  });
});

async function createRepoIsPartnerApiMinted(id: string): Promise<boolean> {
  const { createTransferRepo } = await import('@/db/repos/transfer-repo');
  return createTransferRepo(db).isPartnerApiMinted(id);
}

describe('beginSettlement / beginHold carry the receipt line (pack 6 P10)', () => {
  it("beginSettlement on a 22-char cleared row: the stage-1 body ends with the receipt line; payload keys and outbox kinds unchanged", async () => {
    const t = fixture();
    await store.saveTransfer(t);
    expect(await beginSettlement(db, t, SIMULATOR)).toEqual({ kind: 'started', webhookDriven: true });
    const payload = await stage1Payload(t.id);
    expect(String(payload.body).endsWith(`\nReceipt: ${payUrlFor(t.id)}`)).toBe(true);
    expect(String(payload.body).endsWith(`\n${receiptLine(payUrlFor(t.id))}`)).toBe(true);
    expect(Object.keys(payload).sort()).toEqual(['body', 'category', 'partnerId', 'to']);
    expect(await outboxKinds()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: `stage1:${t.id}` },
      { kind: 'settlement.instruct', dedupe_key: `instruct:${t.id}` },
    ]);
  });

  it('beginHold on a 22-char flagged row: the body ends with the receipt line; keys and the template params unchanged', async () => {
    const t = fixture({ complianceStatus: 'flagged' });
    await store.saveTransfer(t);
    expect(await beginHold(db, t)).toEqual({ kind: 'held' });
    const payload = await stage1Payload(t.id);
    expect(String(payload.body).endsWith(`\nReceipt: ${payUrlFor(t.id)}`)).toBe(true);
    expect(String(payload.body).toLowerCase()).not.toContain('review');
    expect(Object.keys(payload).sort()).toEqual(['body', 'category', 'partnerId', 'template', 'to']);

    // The template is the same one a legacy id gets (no link slot: known limit).
    const legacy = fixture({ id: 'pay12345', complianceStatus: 'flagged' });
    await store.saveTransfer(legacy);
    await beginHold(db, legacy);
    const legacyPayload = await stage1Payload(legacy.id);
    expect(JSON.stringify(payload.template).replaceAll(t.id, '<id>')).toBe(JSON.stringify(legacyPayload.template).replaceAll(legacy.id, '<id>'));
    expect(JSON.stringify(payload.template)).not.toContain('/pay/');
    expect(String(legacyPayload.body)).not.toContain('Receipt:');
  });

  it('a legacy 8-char id and a payment-link row: byte-identical bodies, no receipt line', async () => {
    const legacy = fixture({ id: 'pay12345' });
    const link = fixture();
    await store.saveTransfer(legacy);
    await store.saveTransfer(link);
    await markPaymentLink(link);
    await beginSettlement(db, legacy, MOCK);
    await beginSettlement(db, link, MOCK);
    expect(String((await stage1Payload(legacy.id)).body)).not.toContain('Receipt:');
    expect(String((await stage1Payload(link.id)).body)).not.toContain('Receipt:');
    expect(String((await stage1Payload(link.id)).body).endsWith(`Transfer ID: ${link.id}`)).toBe(true);
  });

  it("the eligibility read failing does not fail the settle: kind 'started', row paid, body without a receipt line", async () => {
    const t = fixture();
    await store.saveTransfer(t);
    probe.linkThrows = true;
    expect(await beginSettlement(db, t, SIMULATOR)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    const body = String((await stage1Payload(t.id)).body);
    expect(body).not.toContain('Receipt:');
    expect(body.endsWith(`Transfer ID: ${t.id}`)).toBe(true);
    expect(logs.calls).toEqual([{ level: 'warn', scope: 'settle.receipt-link', message: 'RangeError', fields: { transferId: t.id } }]);
  });

  it('the read happens on the ROOT handle BEFORE the transaction (beginSettlement and beginHold)', async () => {
    const realTx = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...a: Parameters<typeof realTx>) => {
      probe.order.push('transaction');
      return realTx(...a);
    }) as typeof db.transaction);
    try {
      const paid = fixture();
      await store.saveTransfer(paid);
      await beginSettlement(db, paid, SIMULATOR);
      expect(probe.order).toEqual(['isPaymentLinkTransfer', 'transaction']);
      expect(probe.linkOnRoot).toEqual([true]);

      probe.order = [];
      probe.linkOnRoot = [];
      const held = fixture({ complianceStatus: 'flagged' });
      await store.saveTransfer(held);
      await beginHold(db, held);
      expect(probe.order).toEqual(['isPaymentLinkTransfer', 'transaction']);
      expect(probe.linkOnRoot).toEqual([true]);
    } finally {
      spy.mockRestore();
    }
  });
});
