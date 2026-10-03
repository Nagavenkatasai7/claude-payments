import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { b2bParties, getPortalB2bParties } from '@/lib/portal-transfers';
import { newTransferId } from '@/lib/id';
import type { Transfer } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';

// Lost-features p4 B1: business (B2B) names, entity badges and the funding line on the portal's
// transfer detail and printable receipt. The pure projection keeps ONLY names and enums (never the
// payout destination or the recipient's legal name), drops masked or failed-decrypt names, and is
// null for a consumer transfer. The async read decrypts only for b2b, and only after re-checking
// the same ownership as getPortalTransfer.

const b2b = (over: Partial<Transfer> = {}): Transfer =>
  ({
    id: 'tx1',
    transferType: 'b2b',
    senderEntityType: 'business',
    recipientEntityType: 'business',
    fundingMethod: 'ach_pull',
    ...over,
  }) as Transfer;

describe('b2bParties (pure)', () => {
  it('a consumer transfer (or an absent type) → null', () => {
    expect(b2bParties(b2b({ transferType: 'b2c' }), { senderBusinessName: 'Acme' })).toBeNull();
    expect(b2bParties(b2b({ transferType: undefined }), null)).toBeNull();
  });
  it('b2b with names → the names and both entity types', () => {
    expect(b2bParties(b2b(), { senderBusinessName: 'Acme Imports LLC', recipientBusinessName: 'Mumbai Textiles Pvt' })).toEqual({
      senderEntity: 'business',
      recipientEntity: 'business',
      senderBusinessName: 'Acme Imports LLC',
      recipientBusinessName: 'Mumbai Textiles Pvt',
      funding: 'business_account',
    });
  });
  it('an absent entity type reads as individual', () => {
    const p = b2bParties(b2b({ senderEntityType: undefined, recipientEntityType: undefined }), null);
    expect(p?.senderEntity).toBe('individual');
    expect(p?.recipientEntity).toBe('individual');
  });
  it('masked or failed-decrypt names (****last4) are dropped, as are blank ones', () => {
    const p = b2bParties(b2b(), { senderBusinessName: '****1234', recipientBusinessName: '   ' });
    expect(p).not.toBeNull();
    expect(p).not.toHaveProperty('senderBusinessName');
    expect(p).not.toHaveProperty('recipientBusinessName');
  });
  it('funding: partner-pulled methods are the business account; everything else is card or bank', () => {
    expect(b2bParties(b2b({ fundingMethod: 'ach_pull' }), null)?.funding).toBe('business_account');
    expect(b2bParties(b2b({ fundingMethod: 'bank_pull' }), null)?.funding).toBe('business_account');
    expect(b2bParties(b2b({ fundingMethod: 'credit_card' }), null)?.funding).toBe('card_or_bank');
    expect(b2bParties(b2b({ fundingMethod: 'bank_transfer' }), null)?.funding).toBe('card_or_bank');
  });
  it('returns exactly the listed keys (no destination, no legal name, even when the input has them)', () => {
    const names = { senderBusinessName: 'Acme', recipientBusinessName: 'Mumbai', payoutDestination: '000011112222', recipientLegalName: 'R Legal' };
    const p = b2bParties(b2b({ payoutDestination: '000011112222', recipientLegalName: 'R Legal' }), names);
    expect(Object.keys(p ?? {}).sort()).toEqual(['funding', 'recipientBusinessName', 'recipientEntity', 'senderBusinessName', 'senderEntity']);
  });
});

describe('getPortalB2bParties (PGlite)', () => {
  const PHONE = '14155550101';
  let db: Db;

  async function seedTransfer(over: Partial<Transfer>): Promise<Transfer> {
    const id = newTransferId();
    const t: Transfer = {
      id,
      phone: PHONE,
      amountUsd: 100,
      feeUsd: 0,
      totalChargeUsd: 100,
      fxRate: 85,
      amountInr: 8500,
      recipientName: 'Mumbai Textiles',
      recipientPhone: '919000000000',
      payoutMethod: 'bank',
      payoutDestination: '000011112222|HDFC0000001',
      fundingMethod: 'ach_pull',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'paid',
      createdAt: new Date().toISOString(),
      partnerId: 'pa',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      amountSource: 100,
      feeSource: 0,
      totalChargeSource: 100,
      transferType: 'b2b',
      senderEntityType: 'business',
      recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports LLC',
      recipientBusinessName: 'Mumbai Textiles Pvt',
      ...over,
    };
    await createTransferRepo(db).saveTransfer(t);
    return (await createTransferRepo(db).getOwnedTransfer(t.partnerId, id))!;
  }

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pa', 'Partner A');
    await seedPartner(db, 'pb', 'Partner B');
  });

  it('b2b of this customer → decrypted business names only', async () => {
    const masked = await seedTransfer({});
    expect(masked.senderBusinessName).toMatch(/^\*{4}/);
    const p = await getPortalB2bParties({ partnerId: 'pa', phone: PHONE }, masked, db);
    expect(p).toEqual({
      senderEntity: 'business',
      recipientEntity: 'business',
      senderBusinessName: 'Acme Imports LLC',
      recipientBusinessName: 'Mumbai Textiles Pvt',
      funding: 'business_account',
    });
    expect(JSON.stringify(p)).not.toContain('000011112222');
  });
  it('a consumer transfer makes no second read', async () => {
    const masked = await seedTransfer({ transferType: 'b2c', senderBusinessName: undefined, recipientBusinessName: undefined });
    const noDb = new Proxy({}, { get: () => { throw new Error('unexpected read'); } }) as unknown as Db;
    expect(await getPortalB2bParties({ partnerId: 'pa', phone: PHONE }, masked, noDb)).toBeNull();
  });
  it("another phone's or another partner's transfer → null", async () => {
    const masked = await seedTransfer({});
    expect(await getPortalB2bParties({ partnerId: 'pa', phone: '14155550177' }, masked, db)).toBeNull();
    expect(await getPortalB2bParties({ partnerId: 'pb', phone: PHONE }, masked, db)).toBeNull();
  });
  it('a test-environment row → null', async () => {
    const masked = await seedTransfer({ environment: 'test' });
    expect(await getPortalB2bParties({ partnerId: 'pa', phone: PHONE }, masked, db)).toBeNull();
  });
});
