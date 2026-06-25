import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { transferToRow, rowToTransfer, type TransferRow } from '@/db/repos/mappers';
import { buildSettlementInstruction } from '@/lib/providers/http-payment-provider';
import { wouldBeFeeUsd } from '@/lib/fx';
import { isB2bSendVerified } from '@/lib/kyc-gate';
import { createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import type { Transfer, B2bInvoice } from '@/lib/types';
import type { Db } from '@/db/client';

function b2bTransfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 't_b2b1', phone: '15551112222', amountUsd: 1000, feeUsd: 1.99, totalChargeUsd: 1001.99,
    fxRate: 83, amountInr: 83000, recipientName: 'Acme Imports Ltd', recipientPhone: '',
    payoutMethod: 'bank', payoutDestination: '1234567890', fundingMethod: 'ach_pull',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: '2026-06-25T00:00:00.000Z',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    partnerId: 'default', amountSource: 1000, feeSource: 1.99, totalChargeSource: 1001.99,
    transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
    senderBusinessName: 'Globex Trading LLC', recipientBusinessName: 'Acme Imports Ltd',
    achTokenRef: 'achtok_xyz', invoiceId: 'inv_1',
    ...over,
  };
}
const asRow = (t: Transfer): TransferRow => transferToRow(t) as unknown as TransferRow;

describe('B2B foundation — mappers (encrypt at rest, mask by default)', () => {
  it('encrypts business names, masks ****last4 by default, full only on decrypt; discriminators survive', () => {
    const row = transferToRow(b2bTransfer());
    expect(row.senderBusinessNameEnc).toBeTruthy();
    expect(row.senderBusinessNameEnc).not.toContain('Globex'); // ciphertext, not plaintext
    expect(row.transferType).toBe('b2b');
    expect(row.senderEntityType).toBe('business');

    const masked = rowToTransfer(asRow(b2bTransfer()));
    expect(masked.transferType).toBe('b2b');
    expect(masked.senderBusinessName).toMatch(/^\*{4}/);
    expect(masked.senderBusinessName).not.toContain('Globex');
    expect(masked.achTokenRef).toBe('achtok_xyz');
    expect(masked.invoiceId).toBe('inv_1');

    const full = rowToTransfer(asRow(b2bTransfer()), { decrypt: true });
    expect(full.senderBusinessName).toBe('Globex Trading LLC');
    expect(full.recipientBusinessName).toBe('Acme Imports Ltd');
  });

  it('a consumer transfer defaults to b2c/individual with no business names (path unchanged)', () => {
    const t = b2bTransfer({
      transferType: undefined, senderEntityType: undefined, recipientEntityType: undefined,
      senderBusinessName: undefined, recipientBusinessName: undefined,
      achTokenRef: undefined, invoiceId: undefined, fundingMethod: 'bank_transfer',
    });
    const row = transferToRow(t);
    expect(row.transferType).toBe('b2c');
    expect(row.senderEntityType).toBe('individual');
    expect(row.senderBusinessNameEnc).toBeNull();
    const back = rowToTransfer(asRow(t));
    expect(back.transferType).toBe('b2c');
    expect(back.senderBusinessName).toBeUndefined();
  });
});

describe('B2B foundation — settlement instruction stays non-custodial', () => {
  it('a B2B ACH-pull instruction carries funding{ach_debit, token} + parties (partner pulls; we never capture)', () => {
    const instr = buildSettlementInstruction(b2bTransfer()) as Record<string, unknown>;
    expect(instr.funding).toEqual({ method: 'ach_debit', token: 'achtok_xyz' });
    const parties = instr.parties as Record<string, unknown>;
    expect(parties.sender_business_name).toBe('Globex Trading LLC');
    expect(parties.recipient_entity_type).toBe('business');
  });
  it('a consumer instruction has NO funding/parties block (byte-identical to before)', () => {
    const instr = buildSettlementInstruction(
      b2bTransfer({ transferType: 'b2c', fundingMethod: 'bank_transfer' }),
    ) as Record<string, unknown>;
    expect(instr.funding).toBeUndefined();
    expect(instr.parties).toBeUndefined();
  });
});

describe('B2B foundation — fee + KYB gate', () => {
  it('ACH-pull fee is a flat $1.99', () => {
    expect(wouldBeFeeUsd(1000, 'ach_pull')).toBe(1.99);
  });
  it('isB2bSendVerified requires a verified business customer', () => {
    expect(isB2bSendVerified({ kycStatus: 'verified' })).toBe(true);
    expect(isB2bSendVerified({ kycStatus: 'not_started' })).toBe(false);
    expect(isB2bSendVerified(null)).toBe(false);
  });
});

describe('B2B foundation — mock invoice repo (PGlite, the "ERP" stand-in)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.execute(sql`TRUNCATE b2b_invoices`);
  });
  it('saves, finds the buyer unpaid invoice, then marks it paid (Phase 1 + Phase 4)', async () => {
    const repo = createB2bInvoiceRepo(db);
    const inv: B2bInvoice = {
      id: 'inv_1', partnerId: 'default', businessName: 'Globex Trading LLC', buyerPhone: '15551112222',
      lineItems: [{ description: 'Widgets', qty: 100, unitAmountUsd: 10 }],
      amountUsd: 1000, currency: 'USD', status: 'unpaid', createdAt: '2026-06-25T00:00:00.000Z',
    };
    await repo.saveInvoice(inv);
    const found = await repo.getUnpaidByBuyer('15551112222');
    expect(found?.id).toBe('inv_1');
    expect(found?.lineItems[0].description).toBe('Widgets');
    expect(found?.amountUsd).toBe(1000);

    await repo.markPaid('inv_1', '2026-06-25T01:00:00.000Z');
    expect(await repo.getUnpaidByBuyer('15551112222')).toBeNull(); // no longer unpaid
    expect((await repo.getInvoice('inv_1'))?.status).toBe('paid');
    expect((await repo.listInvoices('default')).length).toBe(1);
  });
});
