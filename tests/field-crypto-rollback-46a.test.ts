import { describe, it, expect } from 'vitest';
import { EnvKeyProvider, encryptField } from '@/lib/field-crypto';
import {
  ctx,
  customerEmailCtx,
  customerRowCtx,
  outboxSealedCtx,
  recipientRowCtx,
  sellerRowCtx,
  type CustomerEncColumn,
  type IntegrationEncColumn,
  type TransferEncColumn,
  type WaitlistEncColumn,
} from '@/lib/crypto-context';
import type { CryptoContext } from '@/lib/field-crypto';
// The 46A reader, frozen (tests/fixtures/field-crypto-46a-reader.ts is a
// byte-for-byte copy of src/lib/field-crypto.ts at 6dbfb1e).
import { decryptField as decryptWith46A } from './fixtures/field-crypto-46a-reader';

// Program-Fix 46B rollback proof. During the 46B rolling release the 46A build
// serves 90% of traffic, and a rollback to 46A must keep reading every v2 row
// 46B wrote. For EVERY context builder a src/ write site uses, seal with the
// CURRENT encryptField and open with the FROZEN 46A decryptField under the
// context the 46A read path builds (crypto-context.ts is unchanged by 46B).

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

const TRANSFER_COLS: TransferEncColumn[] = [
  'payout_destination_enc',
  'recipient_legal_name_enc',
  'sender_business_name_enc',
  'recipient_business_name_enc',
];
const CUSTOMER_COLS: CustomerEncColumn[] = [
  'full_name_enc',
  'date_of_birth_enc',
  'residential_address_enc',
  'gov_id_number_enc',
];
const INTEGRATION_COLS: IntegrationEncColumn[] = [
  'kyc_api_key_enc',
  'kyc_webhook_secret_enc',
  'payment_credentials_enc',
  'payment_webhook_secret_enc',
  'wa_token_enc',
  'wa_verify_token_enc',
  'wa_app_secret_enc',
];
const WAITLIST_COLS: WaitlistEncColumn[] = ['full_name_enc', 'email_enc', 'phone_enc', 'location_enc'];

const cases: Array<[string, CryptoContext]> = [
  ...TRANSFER_COLS.map((c): [string, CryptoContext] => [`transfers.${c}`, ctx.transfer('tr_rb1', c)]),
  ...CUSTOMER_COLS.map((c): [string, CryptoContext] => [
    `customers.${c}`,
    customerRowCtx({ partnerId: 'acme', phone: '15551230000' }, c),
  ]),
  ['customers.email_enc', customerEmailCtx({ partnerId: 'acme', senderPhone: '15551230000' })],
  ['customers.email_enc (default tenant)', customerEmailCtx({ senderPhone: '15551230000' })],
  ['sellers.payout_destination_enc', sellerRowCtx({ partnerId: 'acme', phone: '85291234567' })],
  [
    'recipients.payout_destination_enc',
    recipientRowCtx({ partnerId: 'acme', senderPhone: '15551230000', recipientPhone: '919876543210' }),
  ],
  ['beneficiaries.payout_destination_enc', ctx.beneficiary('ben_rb1')],
  ['schedules.payout_destination_enc', ctx.schedule('sch_rb1')],
  ...INTEGRATION_COLS.map((c): [string, CryptoContext] => [`partner_integrations.${c}`, ctx.integration('acme', c)]),
  ...WAITLIST_COLS.map((c): [string, CryptoContext] => [`waitlist_signups.${c}`, ctx.waitlist('wl_rb1', c)]),
  ['outbox sealed apply_link', outboxSealedCtx('apply_link')],
  ['customer_ref', ctx.purpose('customer_ref')],
];

describe('46B-written blobs open on the frozen 46A reader (rollback safety)', () => {
  it('covers all 27 write contexts', () => {
    expect(cases).toHaveLength(27);
  });

  it.each(cases)('%s: v2 written now opens with the 46A decryptField', (_name, context) => {
    const blob = encryptField('value-under-test', provider, context);
    expect(blob).toMatch(/^v2\.k0\./);
    expect(decryptWith46A(blob, provider, context)).toBe('value-under-test');
  });

  it('the 46A reader still refuses the blob under a different context (binding survives rollback)', () => {
    const blob = encryptField('secret', provider, ctx.integration('acme', 'wa_app_secret_enc'));
    expect(() => decryptWith46A(blob, provider, ctx.integration('acme', 'kyc_api_key_enc'))).toThrow();
    expect(() => decryptWith46A(blob, provider, ctx.integration('globex', 'wa_app_secret_enc'))).toThrow();
  });
});
