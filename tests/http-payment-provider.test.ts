import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const sendText = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
}));

import {
  HttpPaymentProvider,
  normalizeRailStatus,
  parseRailFailure,
  railCallbackTransferId,
  buildSettlementInstruction,
  signBody,
  RAIL_TIMEOUT_MS,
} from '@/lib/providers/http-payment-provider';

function fixture(): Transfer {
  return {
    id: 'rail_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '1234567890', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-09T00:00:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

const PAYMENT = {
  providerType: 'simulator',
  credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sign-secret' },
  webhookSecret: 'cb-secret',
};

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme'); // transfers.partner_id has a real FK to partners
  sendText.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('normalizeRailStatus', () => {
  it('maps the documented rail lifecycle to our domain', () => {
    expect(normalizeRailStatus('created')).toBe('awaiting_payment');
    expect(normalizeRailStatus('funded')).toBe('paid');
    expect(normalizeRailStatus('paid_out')).toBe('delivered');
    expect(normalizeRailStatus('PAID_OUT')).toBe('delivered'); // case-insensitive
  });
  it('failed/unknown/non-string → null (failed/returned are parseRailFailure\'s job, fix 8)', () => {
    expect(normalizeRailStatus('failed')).toBeNull();
    expect(normalizeRailStatus('refunded')).toBeNull();
    expect(normalizeRailStatus(42)).toBeNull();
    expect(normalizeRailStatus(undefined)).toBeNull();
  });
});

describe('railCallbackTransferId', () => {
  it('prefers reference, accepts transferId/transfer_id', () => {
    expect(railCallbackTransferId({ reference: 'a' })).toBe('a');
    expect(railCallbackTransferId({ transferId: 'b' })).toBe('b');
    expect(railCallbackTransferId({ transfer_id: 'c' })).toBe('c');
  });
  it('null for missing/empty/non-object', () => {
    expect(railCallbackTransferId({})).toBeNull();
    expect(railCallbackTransferId({ reference: '' })).toBeNull();
    expect(railCallbackTransferId('x')).toBeNull();
    expect(railCallbackTransferId(null)).toBeNull();
  });
});

describe('HttpPaymentProvider.initiateTransfer — dead path closed (Program-Fix 22, acceptance test 14)', () => {
  it('throws with NO fetch and NO ledger/message side effect: settlement runs through the outbox (settlement.instruct)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(fixture());
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = new HttpPaymentProvider(store, PAYMENT, 'Acme Pay');
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/not used.*settlement\.instruct/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect((await store.getTransfer('rail_t1'))!.status).toBe('awaiting_payment');
    expect((await store.getTransfer('rail_t1'))!.paymentProviderRef).toBeFalsy();
    expect(RAIL_TIMEOUT_MS).toBe(15_000); // the worker's rail deadline is unchanged
  });

  it('static scan: no raw `fetch(settlementUrl` survives anywhere in src/ (the only rail client is safeFetch)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(full, 'utf8').includes('fetch(settlementUrl')) hits.push(full);
      }
    };
    walk(fileURLToPath(new URL('../src', import.meta.url)));
    expect(hits).toEqual([]);
  });
});

describe('HttpPaymentProvider.handleWebhook', () => {
  it('normalizes a rail callback to our domain', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis(), db), PAYMENT);
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'paid_out' }))
      .toEqual({ transferId: 'rail_t1', status: 'delivered' });
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'funded' }))
      .toEqual({ transferId: 'rail_t1', status: 'paid' });
  });
  it('null for missing reference or a truly unmapped status', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis(), db), PAYMENT);
    expect(await provider.handleWebhook({ status: 'paid_out' })).toBeNull();
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 'refunded' })).toBeNull();
    expect(await provider.handleWebhook({ reference: 'rail_t1', status: 42 })).toBeNull();
  });

  // Program-Fix 8 (money-02 / rail-02): a failure callback is a RESULT, not a
  // dropped event. This INVERTS the old lock (`failed → null`).
  it('failed / returned map to a bounded RailFailure (reason scrubbed of control chars, capped at 200)', async () => {
    const provider = new HttpPaymentProvider(createStore(fakeRedis(), db), PAYMENT);
    const noisy = 'bad IFSC\n\u0007' + 'x'.repeat(500);
    const r = await provider.handleWebhook({ reference: 't1', status: 'FAILED', reason: noisy });
    expect(r).toEqual({ transferId: 't1', failure: { code: 'failed', reason: expect.any(String) } });
    const reason = (r as { failure: { reason: string } }).failure.reason;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(reason.startsWith('bad IFSC')).toBe(true);
    expect(await provider.handleWebhook({ reference: 't1', status: 'returned' }))
      .toEqual({ transferId: 't1', failure: { code: 'returned', reason: 'unspecified' } });
  });
});

describe('parseRailFailure (pure)', () => {
  it('maps failed/returned case-insensitively; a non-string or empty reason becomes "unspecified"', () => {
    expect(parseRailFailure({ status: 'Failed', reason: '  ' })).toEqual({ code: 'failed', reason: 'unspecified' });
    expect(parseRailFailure({ status: 'RETURNED', reason: 12 })).toEqual({ code: 'returned', reason: 'unspecified' });
    expect(parseRailFailure({ status: 'returned', reason: 'account_unreachable' }))
      .toEqual({ code: 'returned', reason: 'account_unreachable' });
  });
  it('strips Unicode format characters too: bidi overrides/isolates, line/paragraph separators, zero-width joiners', () => {
    const reason = 'ok\u202Eevil\u202C \u2066x\u2069\u2028y\u2029z\u200D\u200B\uFEFFend';
    const r = parseRailFailure({ status: 'failed', reason });
    expect(r?.reason).toBe('okevil xyzend');
    expect(r?.reason).not.toMatch(/\p{Cf}/u);
  });

  it('null for forward statuses, unknown statuses and non-objects', () => {
    expect(parseRailFailure({ status: 'paid_out' })).toBeNull();
    expect(parseRailFailure({ status: 'refunded' })).toBeNull();
    expect(parseRailFailure({ status: 42 })).toBeNull();
    expect(parseRailFailure(null)).toBeNull();
    expect(parseRailFailure('failed')).toBeNull();
  });
});

describe('signBody + buildSettlementInstruction', () => {
  it('instruction carries the locked FX + non-custodial routing fields', () => {
    const i = buildSettlementInstruction(fixture());
    expect(i).toMatchObject({
      reference: 'rail_t1',
      partner_id: 'acme',
      corridor: { source: 'US', destination: 'IN' },
      payout: { rail: 'bank', destination: '1234567890' },
      amount: { source: 200, currency: 'USD', destination: 16600, destination_currency: 'INR', fx_rate: 83 },
    });
  });
  it('signBody is HMAC-SHA256 hex over the exact body', () => {
    expect(signBody('abc', 'k')).toBe(createHmac('sha256', 'k').update('abc').digest('hex'));
  });
});

describe('buildSettlementInstruction — non-custodial funding legs', () => {
  // A US-domestic B2B ach_pull transfer.
  function achPull(): Transfer {
    return {
      ...fixture(),
      id: 'ach_t1', fundingMethod: 'ach_pull', achTokenRef: 'ach_abc123',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer LLC', recipientBusinessName: 'Acme Pvt Ltd',
    } as Transfer;
  }
  // A cross-border B2B bank_pull transfer: buyer in HK (HKD) → seller in IN (INR).
  // amountSource = PRINCIPAL (1000, reconciles: 1000 * 8.5 = 8500), feeSource = 10,
  // totalChargeSource = 1010 (the FULL buyer debit the funding leg carries).
  function bankPull(): Transfer {
    return {
      ...fixture(),
      id: 'bp_t1', fundingMethod: 'bank_pull', achTokenRef: 'bankpull_deadbeef',
      sourceCountry: 'HK', sourceCurrency: 'HKD', amountSource: 1000, feeSource: 10, totalChargeSource: 1010,
      destinationCountry: 'IN', destinationCurrency: 'INR', amountInr: 8500, fxRate: 8.5,
      payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
      recipientName: 'Mumbai Imports', recipientPhone: '919876543210',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'HK Buyer Co', recipientBusinessName: 'Mumbai Imports',
    } as Transfer;
  }

  it('b2c (card/bank) carries NO funding block — byte-unchanged', () => {
    const i = buildSettlementInstruction(fixture()) as Record<string, unknown>;
    expect('funding' in i).toBe(false);
    expect('parties' in i).toBe(false);
  });

  it('ach_pull funding block is byte-unchanged: {method:ach_debit, token} only', () => {
    const i = buildSettlementInstruction(achPull()) as Record<string, unknown>;
    expect(i.funding).toEqual({ method: 'ach_debit', token: 'ach_abc123' });
    // ach_pull must NOT gain the bank_pull cross-border fields.
    expect(i.funding).not.toHaveProperty('amount');
    expect(i.funding).not.toHaveProperty('country');
  });

  it('bank_pull is a SIGNED DUAL-LEG instruction: FUNDING (debit buyer) + PAYOUT (pay seller exactly)', () => {
    const i = buildSettlementInstruction(bankPull()) as Record<string, unknown>;
    // FUNDING leg — debit the BUYER's local bank for the FULL buyer total
    // (totalChargeSource = 1010, principal + fee) in HKD. token is OPAQUE (no raw
    // bank digits); SmartRemit captures nothing.
    expect(i.funding).toEqual({
      method: 'bank_debit',
      token: 'bankpull_deadbeef',
      amount: 1010,
      currency: 'HKD',
      country: 'HK',
    });
    // PAYOUT leg — pay the SELLER their EXACT invoiced amount in the seller currency,
    // to the seller-profile destination. amount.source = principal (1000), so
    // source * fx_rate (1000 * 8.5) === destination (8500) — reconciles.
    expect(i.payout).toEqual({ rail: 'bank', destination: '123456789 HDFC0001234' });
    expect(i.amount).toMatchObject({
      source: 1000, currency: 'HKD',
      destination: 8500, destination_currency: 'INR', fx_rate: 8.5,
    });
    // It's a B2B instruction (parties present), and the same HMAC recipe signs it.
    expect(i.parties).toMatchObject({ recipient_business_name: 'Mumbai Imports' });
    const body = JSON.stringify(i);
    expect(signBody(body, 'sign-secret')).toBe(createHmac('sha256', 'sign-secret').update(body).digest('hex'));
  });
});

describe('buildSettlementInstruction — USDC seller payout leg', () => {
  const WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

  // A cross-border B2B bank_pull whose SELLER chose a USDC wallet payout: the
  // ledger row carries the canonical `USDC|<address>` profile destination.
  function usdcSeller(): Transfer {
    return {
      ...fixture(),
      id: 'usdc_t1', fundingMethod: 'bank_pull', achTokenRef: 'bankpull_deadbeef',
      sourceCountry: 'US', sourceCurrency: 'USD', amountSource: 128.4, feeSource: 5, totalChargeSource: 133.4,
      destinationCountry: 'HK', destinationCurrency: 'HKD', amountInr: 1000, fxRate: 7.788,
      payoutMethod: 'usdc', payoutDestination: `USDC|${WALLET}`,
      recipientName: 'Kowloon Design Co', recipientPhone: '85291234567',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'US Buyer Co', recipientBusinessName: 'Kowloon Design Co',
    } as Transfer;
  }

  it('usdc seller ⇒ payout { rail: usdc, destination: the BARE 0x address } — prefix stripped for the wire', () => {
    const i = buildSettlementInstruction(usdcSeller()) as Record<string, unknown>;
    expect(i.payout).toEqual({ rail: 'usdc', destination: WALLET });
    // The seller still nets EXACTLY the invoiced amount — same field, same value.
    expect(i.amount).toMatchObject({ destination: 1000, destination_currency: 'HKD' });
    // The buyer-side FUNDING leg is byte-unchanged by the payout rail.
    expect(i.funding).toEqual({
      method: 'bank_debit', token: 'bankpull_deadbeef', amount: 133.4, currency: 'USD', country: 'US',
    });
  });

  it('a BANK seller instruction is byte-unchanged by the usdc feature', () => {
    const bank = {
      ...usdcSeller(),
      payoutMethod: 'bank', payoutDestination: '024 388 12345678',
    } as Transfer;
    const i = buildSettlementInstruction(bank) as Record<string, unknown>;
    expect(i.payout).toEqual({ rail: 'bank', destination: '024 388 12345678' });
  });

  it('defensive: a usdc payout whose destination lacks the prefix passes the raw value through', () => {
    const t = { ...usdcSeller(), payoutDestination: WALLET } as Transfer;
    const i = buildSettlementInstruction(t) as Record<string, unknown>;
    expect(i.payout).toEqual({ rail: 'usdc', destination: WALLET });
  });
});

describe('buildSettlementInstruction — ctx-01 backstops (fix 6)', () => {
  it('throws instead of instructing the rail to pay a masked placeholder', () => {
    for (const bad of ['****9012', '****', '********', 'account on file', 'bank a/c ****9012', '•••• 9012']) {
      expect(() => buildSettlementInstruction({ ...fixture(), payoutDestination: bad }), bad)
        .toThrow('settlement_destination_invalid:rail_t1');
    }
  });

  it('the error carries the transfer id only — never the destination', () => {
    let message = '';
    try {
      buildSettlementInstruction({ ...fixture(), payoutDestination: '****9012' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe('settlement_destination_invalid:rail_t1');
    expect(message).not.toContain('9012');
  });

  it('throws for a CONSUMER row carrying a partner-pulled funding method (never charged by us, never legitimately pulled)', () => {
    for (const fundingMethod of ['ach_pull', 'bank_pull'] as const) {
      expect(() => buildSettlementInstruction({ ...fixture(), fundingMethod }), fundingMethod)
        .toThrow('settlement_funding_invalid:rail_t1');
    }
  });

  it('real bank / UPI / USDC destinations build unchanged, and a B2B ach_pull row with NO destination still builds', () => {
    type Built = { payout: { destination: string } };
    expect((buildSettlementInstruction(fixture()) as Built).payout.destination).toBe('1234567890');
    expect((buildSettlementInstruction({ ...fixture(), payoutMethod: 'upi', payoutDestination: 'mom@okhdfc' }) as Built)
      .payout.destination).toBe('mom@okhdfc');
    const wallet = '0x' + 'b'.repeat(40);
    expect((buildSettlementInstruction({ ...fixture(), payoutMethod: 'usdc', payoutDestination: `USDC|${wallet}` }) as Built)
      .payout.destination).toBe(wallet);
    const b2b = buildSettlementInstruction({
      ...fixture(), fundingMethod: 'ach_pull', achTokenRef: 'ach_abc', transferType: 'b2b', payoutDestination: '',
    } as Transfer) as Built;
    expect(b2b.payout.destination).toBe('');
  });

  it('existing B2B funding-leg fixtures still build (they all carry transferType b2b)', () => {
    const achPull = { ...fixture(), id: 'ach_t2', fundingMethod: 'ach_pull', achTokenRef: 'ach_x', transferType: 'b2b' } as Transfer;
    expect((buildSettlementInstruction(achPull) as { funding?: { method: string } }).funding?.method).toBe('ach_debit');
  });
});

describe('buildSettlementInstruction — an empty destination only on a B2B partner-pulled row (fix 10 review S2)', () => {
  it('throws for an empty / blank destination on a consumer row, and on a B2B row that is not partner-pulled', () => {
    const cases: Array<Partial<Transfer>> = [
      { payoutDestination: '' },
      { payoutDestination: '   ' },
      { payoutDestination: '', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business', fundingMethod: 'bank_transfer' },
    ];
    for (const over of cases) {
      expect(() => buildSettlementInstruction({ ...fixture(), ...over } as Transfer), JSON.stringify(over))
        .toThrow('settlement_destination_invalid:rail_t1');
    }
  });

  it('a B2B ach_pull or bank_pull row with no destination still builds (the partner pays the payee)', () => {
    for (const fundingMethod of ['ach_pull', 'bank_pull'] as const) {
      const built = buildSettlementInstruction({
        ...fixture(), fundingMethod, achTokenRef: 'ach_abc', transferType: 'b2b', payoutDestination: '',
      } as Transfer) as { payout: { destination: string } };
      expect(built.payout.destination, fundingMethod).toBe('');
    }
  });
});
