import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { EnvKeyProvider, decryptField, encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { createBeneficiaryRepo, createRecipientRepo, createSellerRepo } from '@/db/repos/aux-repos';
import {
  REENCRYPT_TABLES,
  parseReencryptArgs,
  reencryptAadV2,
} from '../scripts/reencrypt-aad-v2';
import type { Transfer } from '@/lib/types';

// Program-Fix 46A: the owner-run re-encrypt (v1 → v2) script. Built and tested
// here; NEVER wired into package.json or CI, never run by the loop. Dry run by
// default; --apply also needs --confirm-snapshot-taken; each write is a
// compare-and-set on (row key, old blob).

// tests/setup.ts pins FIELD_ENCRYPTION_KEY to 32×0x07; the seller repo uses the
// env provider, so every repo here shares that key.
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const now = '2026-06-09T12:00:00.000Z';
let db: Db;

async function raw(query: string): Promise<Record<string, string | null>[]> {
  const res = await db.execute(sql.raw(query));
  return (res as unknown as { rows: Record<string, string | null>[] }).rows;
}

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: 'tr_re1', phone: '15551230000', amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99, fxRate: 85.2,
  amountInr: 17040, recipientName: 'Anita', recipientPhone: '919876543210', payoutMethod: 'bank',
  payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
  complianceReasons: [], status: 'awaiting_payment', createdAt: now, sourceCountry: 'US', sourceCurrency: 'USD',
  destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 1.99,
  totalChargeSource: 201.99, ...over,
});

/** One v1 row in every table the script covers (the production write path today). */
async function seedV1Everywhere(): Promise<void> {
  await seedPartner(db, 'acme');
  await createTransferRepo(db, provider).saveTransfer(
    transfer({ recipientLegalName: 'Anita Sharma', transferType: 'b2b', senderBusinessName: 'Acme Imports', recipientBusinessName: 'Mumbai Tex' }),
  );
  await createTransferRepo(db, provider).saveTransfer(transfer({ id: 'tr_re2', payoutDestination: '' })); // '' stays ''
  await createCustomerRepo(db, async () => null, provider).saveCustomer({
    senderPhone: '15551230000', firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US', partnerId: 'acme',
    fullName: 'Asha Patel', dateOfBirth: '1990-01-02', residentialAddress: '1 Main St', govIdNumber: 'P1234567',
    email: encryptField('asha@example.com', provider), createdAt: now, updatedAt: now,
  });
  const sellers = createSellerRepo(db);
  await sellers.createSeller({ id: 's_re1', partnerId: 'default', phone: '85291234567', businessName: 'Kowloon Co', country: 'HK', currency: 'HKD' });
  await sellers.setPayoutDestination('85291234567', 'default', 'HK|024|388|123456789');
  await createRecipientRepo(db, provider).upsertRecipient('acme', '15551230000', {
    name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: now,
  });
  await createBeneficiaryRepo(db, provider).createBeneficiary({
    id: 'ben_re1', partnerId: 'acme', name: 'Anita', country: 'IN', payoutMethod: 'bank', payoutDestination: '123456789012', createdAt: now,
  });
  await createScheduleRepo(db, provider).saveSchedule({
    id: 'sch_re1', phone: '15551230000', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '999888777666', fundingMethod: 'bank_transfer', frequency: 'monthly',
    dayOfMonth: 5, status: 'active', createdAt: now, partnerId: 'default', sourceCurrency: 'USD', amountSource: 100,
  });
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
    kyc: { providerType: 'persona', apiKey: 'persona_secret', webhookSecret: 'whk_kyc' },
    payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail' }, webhookSecret: 'whk_pay' },
    whatsapp: { phoneNumberId: '111222', token: 'EAAtok', verifyToken: 'vrfy', appSecret: 'meta_sec' },
  });
  await createWaitlistRepo(db, provider).insertIfNew({
    id: 'wl_re1', fullName: 'Asha Patel', email: 'asha.patel@example.com', phone: '+15551234567', location: 'Fairfax, VA',
    destinations: ['IN'], consentAt: now, consentTextVersion: 'v1', utmSource: undefined, utmCampaign: undefined,
  });
}

beforeEach(async () => {
  db = await freshDb();
});

describe('scripts/reencrypt-aad-v2 (fix 46A)', { retry: 0 }, () => {
  it('covers exactly the brief §4 Postgres columns', () => {
    const cols = REENCRYPT_TABLES.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)).sort();
    expect(cols).toEqual(
      [
        'beneficiaries.payout_destination_enc',
        'customers.date_of_birth_enc', 'customers.email_enc', 'customers.full_name_enc',
        'customers.gov_id_number_enc', 'customers.mfa_totp_enc', 'customers.residential_address_enc',
        'partner_integrations.kyc_api_key_enc', 'partner_integrations.kyc_webhook_secret_enc',
        'partner_integrations.payment_credentials_enc', 'partner_integrations.payment_webhook_secret_enc',
        'partner_integrations.wa_app_secret_enc', 'partner_integrations.wa_token_enc', 'partner_integrations.wa_verify_token_enc',
        'recipients.payout_destination_enc',
        'schedules.payout_destination_enc',
        'sellers.payout_destination_enc',
        'transfers.payout_destination_enc', 'transfers.recipient_business_name_enc',
        'transfers.recipient_legal_name_enc', 'transfers.sender_business_name_enc',
        'waitlist_signups.email_enc', 'waitlist_signups.full_name_enc',
        'waitlist_signups.location_enc', 'waitlist_signups.phone_enc',
      ].sort(),
    );
  });

  it('DRY RUN (default) counts v1 rows per column and writes nothing', async () => {
    await seedV1Everywhere();
    const before = await raw(`SELECT payout_destination_enc FROM transfers ORDER BY id`);
    const report = await reencryptAadV2(db, { apply: false, provider });
    const count = (t: string, c: string) => report.find((r) => r.table === t && r.column === c)!;
    expect(count('transfers', 'payout_destination_enc')).toMatchObject({ v1: 1, resealed: 0 });
    expect(count('customers', 'email_enc')).toMatchObject({ v1: 1, resealed: 0 });
    expect(count('partner_integrations', 'wa_app_secret_enc')).toMatchObject({ v1: 1 });
    expect(report.reduce((n, r) => n + r.v1, 0)).toBe(24);
    expect(report.every((r) => r.resealed === 0 && r.skipped === 0 && r.failed === 0)).toBe(true);
    expect(await raw(`SELECT payout_destination_enc FROM transfers ORDER BY id`)).toEqual(before);
  });

  it('APPLY re-seals every v1 value as v2 bound to its row; every repo still reads the same plaintext', async () => {
    await seedV1Everywhere();
    const report = await reencryptAadV2(db, { apply: true, provider, batch: 2 });
    expect(report.reduce((n, r) => n + r.resealed, 0)).toBe(24);
    expect(report.every((r) => r.failed === 0 && r.skipped === 0)).toBe(true);

    // No v1 left anywhere; '' / NULL untouched.
    const again = await reencryptAadV2(db, { apply: false, provider });
    expect(again.reduce((n, r) => n + r.v1, 0)).toBe(0);
    expect((await raw(`SELECT payout_destination_enc FROM transfers WHERE id = 'tr_re2'`))[0].payout_destination_enc).toBe('');

    const t = await createTransferRepo(db, provider).getTransfer('tr_re1', { decrypt: true });
    expect([t!.payoutDestination, t!.recipientLegalName, t!.senderBusinessName, t!.recipientBusinessName]).toEqual([
      '123456789012|HDFC0001234', 'Anita Sharma', 'Acme Imports', 'Mumbai Tex',
    ]);
    const c = (await createCustomerRepo(db, async () => null, provider).getCustomer('acme', '15551230000'))!;
    expect([c.fullName, c.dateOfBirth, c.residentialAddress, c.govIdNumber]).toEqual([
      'Asha Patel', '1990-01-02', '1 Main St', 'P1234567',
    ]);
    expect(c.email!.startsWith('v2.k0.')).toBe(true);
    expect(decryptField(c.email!, provider, ctx.customer('acme', '15551230000', 'email_enc'))).toBe('asha@example.com');
    expect((await createSellerRepo(db).getSellerDecrypted('85291234567', 'default'))!.payoutDestination).toBe('HK|024|388|123456789');
    expect((await createRecipientRepo(db, provider).listRecipients('acme', '15551230000', 5))[0].payoutDestination).toBe('111122223333');
    expect((await createBeneficiaryRepo(db, provider).getOwnedBeneficiary('acme', 'ben_re1'))!.payoutDestination).toBe('123456789012');
    expect((await createScheduleRepo(db, provider).getSchedule('sch_re1'))!.payoutDestination).toBe('999888777666');
    const integ = await createIntegrationsRepo(db, provider).getIntegrations('acme');
    expect(integ.whatsapp.appSecret).toBe('meta_sec');
    expect(integ.payment.credentials).toEqual({ settlementUrl: 'https://rail' });
    const [w] = await createWaitlistRepo(db, provider).listDecrypted();
    expect([w.fullName, w.email, w.phone, w.location]).toEqual(['Asha Patel', 'asha.patel@example.com', '+15551234567', 'Fairfax, VA']);
  });

  it('--table limits the run to one table', async () => {
    await seedV1Everywhere();
    const report = await reencryptAadV2(db, { apply: true, provider, table: 'partner_integrations' });
    expect(new Set(report.map((r) => r.table))).toEqual(new Set(['partner_integrations']));
    expect(report.reduce((n, r) => n + r.resealed, 0)).toBe(7);
    const rest = await reencryptAadV2(db, { apply: false, provider });
    expect(rest.reduce((n, r) => n + r.v1, 0)).toBe(17);
  });

  it('the compare-and-set skips a row changed concurrently (never overwrites a newer value)', async () => {
    await seedV1Everywhere();
    const newer = encryptField('000011112222', provider);
    const report = await reencryptAadV2(db, {
      apply: true,
      provider,
      table: 'schedules',
      // Test seam: a concurrent writer replaces the blob between the read and the CAS.
      beforeWrite: async ({ table }) => {
        if (table === 'schedules') {
          await db.execute(sql`UPDATE schedules SET payout_destination_enc = ${newer} WHERE id = 'sch_re1'`);
        }
      },
    });
    expect(report[0]).toMatchObject({ table: 'schedules', v1: 1, resealed: 0, skipped: 1 });
    expect((await raw(`SELECT payout_destination_enc FROM schedules`))[0].payout_destination_enc).toBe(newer);
  });

  it('a value that does not decrypt is counted as failed and left untouched', async () => {
    await seedV1Everywhere();
    await db.execute(sql`UPDATE beneficiaries SET payout_destination_enc = 'v1.AAAA.BBBB.CCCC.DDDD' WHERE id = 'ben_re1'`);
    const report = await reencryptAadV2(db, { apply: true, provider, table: 'beneficiaries' });
    expect(report[0]).toMatchObject({ v1: 1, resealed: 0, failed: 1 });
    expect((await raw(`SELECT payout_destination_enc FROM beneficiaries`))[0].payout_destination_enc).toBe('v1.AAAA.BBBB.CCCC.DDDD');
  });
});

describe('parseReencryptArgs', () => {
  it('defaults to a dry run over every table, batch 200', () => {
    expect(parseReencryptArgs([])).toEqual({ ok: true, apply: false, batch: 200, table: undefined });
  });

  it('--apply WITHOUT --confirm-snapshot-taken is refused', () => {
    expect(parseReencryptArgs(['--apply']).ok).toBe(false);
    expect(parseReencryptArgs(['--apply', '--confirm-snapshot-taken'])).toMatchObject({ ok: true, apply: true });
  });

  it('validates --table and --batch', () => {
    expect(parseReencryptArgs(['--table', 'customers'])).toMatchObject({ ok: true, table: 'customers' });
    expect(parseReencryptArgs(['--table', 'users; drop']).ok).toBe(false);
    expect(parseReencryptArgs(['--batch', '50'])).toMatchObject({ ok: true, batch: 50 });
    expect(parseReencryptArgs(['--batch', '0']).ok).toBe(false);
    expect(parseReencryptArgs(['--batch', 'x']).ok).toBe(false);
  });

  it('is never wired into package.json scripts or CI', () => {
    expect(readFileSync('package.json', 'utf8')).not.toContain('reencrypt-aad-v2');
  });
});
