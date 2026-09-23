import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { createBeneficiaryRepo, createRecipientRepo, createSellerRepo } from '@/db/repos/aux-repos';
import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';
import {
  EnvKeyProvider,
  decryptField,
  encryptField,
  defaultProvider,
} from '@/lib/field-crypto';
import { customerEmailCtx, ctx, outboxSealedCtx } from '@/lib/crypto-context';
import { renderSealedText } from '@/lib/sealed-text';
import { openCustomerRef, sealCustomerRef } from '@/lib/customer-ref';
import type { Customer, Schedule, Transfer } from '@/lib/types';

// Program-Fix 46A/46B — for EVERY table in the brief's §4, a repo-level
// "write → read back equal" round trip. Since 46B the production writer seals
// v2 by DEFAULT: nothing here switches it on (the 46A test-only seam is retired
// and never called). Each case first asserts the stored column starts with
// `v2.`: that proves the write side threaded a context (a silent v1 fallback
// would still round-trip).

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const now = '2026-06-09T12:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await freshDb();
});

async function raw(query: string): Promise<Record<string, string | null>[]> {
  const res = await db.execute(sql.raw(query));
  return (res as unknown as { rows: Record<string, string | null>[] }).rows;
}

function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_aad1',
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
    createdAt: now,
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

const customerFixture = (over: Partial<Customer> = {}): Customer => ({
  senderPhone: '15551230000',
  firstSeenAt: now,
  kycStatus: 'verified',
  senderCountry: 'US',
  partnerId: 'default',
  fullName: 'Asha Patel',
  dateOfBirth: '1990-01-02',
  residentialAddress: '1 Main St',
  govIdNumber: 'P1234567',
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('repo AAD v2 round trips (every table, v2 is the default writer)', { retry: 0 }, () => {
  it('transfers: 4 columns via transferToRow → decrypted read', async () => {
    const repo = createTransferRepo(db, provider);
    await repo.saveTransfer(
      transferFixture({
        recipientLegalName: 'Anita Sharma',
        transferType: 'b2b',
        senderBusinessName: 'Acme Imports LLC',
        recipientBusinessName: 'Mumbai Textiles Pvt',
      }),
    );
    const [row] = await raw(
      `SELECT payout_destination_enc, recipient_legal_name_enc, sender_business_name_enc, recipient_business_name_enc FROM transfers`,
    );
    for (const v of Object.values(row)) expect(v).toMatch(/^v2\.k0\./);
    const back = await repo.getTransfer('tr_aad1', { decrypt: true });
    expect(back!.payoutDestination).toBe('123456789012|HDFC0001234');
    expect(back!.recipientLegalName).toBe('Anita Sharma');
    expect(back!.senderBusinessName).toBe('Acme Imports LLC');
    expect(back!.recipientBusinessName).toBe('Mumbai Textiles Pvt');
  });

  it('transfers: setPayoutIfEditable (the pay page payout write)', async () => {
    const repo = createTransferRepo(db, provider);
    await repo.saveTransfer(transferFixture({ payoutDestination: '' }));
    const updated = await repo.setPayoutIfEditable('tr_aad1', 'default', {
      payoutMethod: 'bank',
      payoutDestination: '555566667777',
    });
    expect(updated).not.toBeNull();
    const [row] = await raw(`SELECT payout_destination_enc FROM transfers`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    expect((await repo.getTransfer('tr_aad1', { decrypt: true }))!.payoutDestination).toBe('555566667777');
  });

  it('customers: 4 PII columns via customerToRow → getCustomer, and resolveSenderNames', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customerFixture());
    const [row] = await raw(
      `SELECT full_name_enc, date_of_birth_enc, residential_address_enc, gov_id_number_enc FROM customers`,
    );
    for (const v of Object.values(row)) expect(v).toMatch(/^v2\.k0\./);
    const back = await repo.getCustomer('default', '15551230000');
    expect(back!.fullName).toBe('Asha Patel');
    expect(back!.dateOfBirth).toBe('1990-01-02');
    expect(back!.residentialAddress).toBe('1 Main St');
    expect(back!.govIdNumber).toBe('P1234567');
    const names = await resolveSenderNames(db, [{ partnerId: 'default', phone: '15551230000' }], { provider });
    expect(names.get(senderNameKey('default', '15551230000'))).toBe('Asha Patel');
  });

  it('customers.email_enc: sealed outside the repo with customerEmailCtx, opened from the read row', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    const c = customerFixture({ partnerId: 'acme' });
    await repo.saveCustomer({ ...c, email: encryptField('asha@example.com', provider, customerEmailCtx(c)) });
    const [row] = await raw(`SELECT email_enc FROM customers`);
    expect(row.email_enc).toMatch(/^v2\.k0\./);
    const back = (await repo.getCustomer('acme', '15551230000'))!;
    expect(decryptField(back.email!, provider, customerEmailCtx(back))).toBe('asha@example.com');
  });

  it('ctx-mismatched customers.full_name_enc → getCustomer throws, never fullName undefined', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customerFixture({ senderPhone: '15550001111', fullName: 'Victim Name' }));
    await repo.saveCustomer(customerFixture({ senderPhone: '15550002222', fullName: 'Other Name' }));
    // B's row now holds a value sealed under A's context.
    await db.execute(
      sql`UPDATE customers SET full_name_enc = (SELECT full_name_enc FROM customers WHERE phone = '15550001111') WHERE phone = '15550002222'`,
    );
    await expect(repo.getCustomer('default', '15550002222')).rejects.toThrow();
    // The untouched row still reads.
    expect((await repo.getCustomer('default', '15550001111'))!.fullName).toBe('Victim Name');
  });

  it('sellers: setPayoutDestination and activateOnboarding → getSellerDecrypted', async () => {
    const repo = createSellerRepo(db);
    const base = {
      id: 's_aad1', partnerId: 'default', phone: '85291234567',
      businessName: 'Kowloon Design Co', country: 'HK' as const, currency: 'HKD' as const,
    };
    await repo.createSeller(base);
    await repo.setPayoutDestination('+852 9123 4567', 'default', 'HK|024|388|123456789');
    let [row] = await raw(`SELECT payout_destination_enc FROM sellers`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    expect((await repo.getSellerDecrypted('85291234567', 'default'))!.payoutDestination).toBe('HK|024|388|123456789');

    await repo.activateOnboarding('85291234567', 'default', 'HK|024|388|999988887');
    [row] = await raw(`SELECT payout_destination_enc FROM sellers`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    expect((await repo.getSellerDecrypted('85291234567', 'default'))!.payoutDestination).toBe('HK|024|388|999988887');
    // The env-default provider is what the seller repo uses.
    expect(defaultProvider()).toBeDefined();
  });

  it('recipients: upsertRecipient → listRecipients', async () => {
    const repo = createRecipientRepo(db, provider);
    await repo.upsertRecipient('default', '15551230000', {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank',
      payoutDestination: '111122223333', lastUsedAt: now,
    });
    const [row] = await raw(`SELECT payout_destination_enc FROM recipients`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    const [back] = await repo.listRecipients('default', '15551230000', 5);
    expect(back.payoutDestination).toBe('111122223333');
  });

  it('beneficiaries: createBeneficiary → getOwnedBeneficiary', async () => {
    await seedPartner(db, 'acme');
    const repo = createBeneficiaryRepo(db, provider);
    await repo.createBeneficiary({
      id: 'ben_aad1', partnerId: 'acme', name: 'Anita', country: 'IN',
      payoutMethod: 'bank', payoutDestination: '123456789012', createdAt: now,
    });
    const [row] = await raw(`SELECT payout_destination_enc FROM beneficiaries`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    expect((await repo.getOwnedBeneficiary('acme', 'ben_aad1'))!.payoutDestination).toBe('123456789012');
  });

  it('schedules: saveSchedule → getSchedule', async () => {
    const repo = createScheduleRepo(db, provider);
    const s: Schedule = {
      id: 'sch_aad1', phone: '15551230000', amountUsd: 100, recipientName: 'Mom',
      recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '999888777666',
      fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 5, status: 'active',
      createdAt: now, partnerId: 'default', sourceCurrency: 'USD', amountSource: 100,
    };
    await repo.saveSchedule(s);
    const [row] = await raw(`SELECT payout_destination_enc FROM schedules`);
    expect(row.payout_destination_enc).toMatch(/^v2\.k0\./);
    expect(await repo.getSchedule('sch_aad1')).toEqual(s);
  });

  it('partner_integrations: 7 columns via saveIntegrations → getIntegrations', async () => {
    await seedPartner(db, 'acme');
    const repo = createIntegrationsRepo(db, provider);
    const FULL = {
      kyc: { providerType: 'persona' as const, apiKey: 'persona_secret', webhookSecret: 'whk_kyc' },
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail', signingSecret: 'sgn' }, webhookSecret: 'whk_pay' },
      whatsapp: { phoneNumberId: '111222', token: 'EAAtok', verifyToken: 'vrfy', appSecret: 'meta_sec' },
    };
    await repo.saveIntegrations('acme', FULL);
    const [row] = await raw(
      `SELECT kyc_api_key_enc, kyc_webhook_secret_enc, payment_credentials_enc, payment_webhook_secret_enc, wa_token_enc, wa_verify_token_enc, wa_app_secret_enc FROM partner_integrations`,
    );
    expect(Object.values(row)).toHaveLength(7);
    for (const v of Object.values(row)) expect(v).toMatch(/^v2\.k0\./);
    expect(await repo.getIntegrations('acme')).toEqual(FULL);
  });

  it('waitlist_signups: 4 columns via insertIfNew → listDecrypted', async () => {
    const repo = createWaitlistRepo(db, provider);
    await repo.insertIfNew({
      id: 'wl_aad1', fullName: 'Asha Patel', email: 'asha.patel@example.com', phone: '+15551234567',
      location: 'Fairfax, VA', destinations: ['IN'], consentAt: now, consentTextVersion: 'v1',
      utmSource: undefined, utmCampaign: undefined,
    });
    const [row] = await raw(`SELECT full_name_enc, email_enc, phone_enc, location_enc FROM waitlist_signups`);
    for (const v of Object.values(row)) expect(v).toMatch(/^v2\.k0\./);
    const [back] = await repo.listDecrypted();
    expect([back.fullName, back.email, back.phone, back.location]).toEqual([
      'Asha Patel', 'asha.patel@example.com', '+15551234567', 'Fairfax, VA',
    ]);
  });

  it('partner_integrations: a value read under a mismatched context throws', async () => {
    await seedPartner(db, 'acme');
    await seedPartner(db, 'globex');
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', { kyc: { providerType: 'persona', apiKey: 'k1' }, payment: {}, whatsapp: { appSecret: 'secret-a' } });
    await repo.saveIntegrations('globex', { kyc: { providerType: 'persona', apiKey: 'k2' }, payment: {}, whatsapp: {} });
    await db.execute(
      sql`UPDATE partner_integrations SET kyc_api_key_enc = (SELECT wa_app_secret_enc FROM partner_integrations WHERE partner_id = 'acme') WHERE partner_id = 'globex'`,
    );
    await expect(repo.getIntegrations('globex')).rejects.toThrow();
    // Sanity: the pinned context is what the acme row was sealed under.
    const [row] = await raw(`SELECT wa_app_secret_enc FROM partner_integrations WHERE partner_id = 'acme'`);
    expect(decryptField(row.wa_app_secret_enc!, provider, ctx.integration('acme', 'wa_app_secret_enc'))).toBe('secret-a');
  });
  it('customers: setFullNameIfUnset (#335 set-once writer) → getCustomer and resolveSenderNames', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customerFixture({ partnerId: 'acme', fullName: undefined }));
    expect(await repo.setFullNameIfUnset('acme', '15551230000', 'Asha Patel')).toBe(true);
    const [row] = await raw(`SELECT full_name_enc FROM customers`);
    expect(row.full_name_enc).toMatch(/^v2\.k0\./);
    expect((await repo.getCustomer('acme', '15551230000'))!.fullName).toBe('Asha Patel');
    const names = await resolveSenderNames(db, [{ partnerId: 'acme', phone: '15551230000' }], { provider });
    expect(names.get(senderNameKey('acme', '15551230000'))).toBe('Asha Patel');
  });

  it('outbox apply_link: sealed with outboxSealedCtx → renderSealedText opens it', () => {
    const blob = encryptField('https://example.test/partners/apply/tok', undefined, outboxSealedCtx('apply_link'));
    expect(blob).toMatch(/^v2\.k0\./);
    expect(renderSealedText('Apply: {{apply_link}}', { apply_link: blob })).toBe(
      'Apply: https://example.test/partners/apply/tok',
    );
  });

  it('customer_ref: sealCustomerRef writes v2 → openCustomerRef opens it', () => {
    const ref = sealCustomerRef('acme', '15551230000');
    expect(ref).toMatch(/^v2\.k0\./);
    expect(openCustomerRef(ref)).toEqual({ partnerId: 'acme', phone: '15551230000' });
  });
});
